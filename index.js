import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    getCurrentChatId,
    getCurrentChatDetails,
    chat_metadata,
    chat,
    characters,
    this_chid,
} from '../../../../script.js';
import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
import {
    resolveBankIdentity,
    buildModelEndpoints,
    parseBanksResponse,
    computeSegmentPlan,
    queryTextForMessages,
    formatRecall,
    buildRetainPayload,
    buildExplicitRetainPayload,
    buildRecallPayload,
    buildReflectPayload,
    formatUiStatus,
    deriveChatLabel,
    createChatSnapshot,
    isSnapshotCurrent,
    canSaveMetadata,
    getReadiness,
    resolveCurrentCharacter,
    resolveNetworkActionTarget,
    acknowledgeSegmentAction,
    isMetadataCompatible,
    normalizeMetadata,
} from './core.js';

const MODULE = 'hindsight';
const METADATA_KEY = 'hindsight_memory';
const DEFAULTS = {
    enabled: false,
    hindsightUrl: '',
    providerUrl: '',
    providerApiKey: '',
    bankMode: 'auto', // auto | character | custom
    bankId: 'sillytavern', // legacy compat
    customBankId: 'sillytavern',
    messagesPerDocument: 15,
    discoveredBanks: [],
    model: 'auto',
    recallMode: 'recall',
    budget: 'mid',
    maxTokens: 2200,
    injectionPosition: extension_prompt_types.IN_PROMPT,
    injectionDepth: 4,
};
const MAX_QUERY_CHARS = 8000;
let retainTimer = null;
let retainInFlight = false;
let retainQueued = false;
let recallGenerationKey = '';
let settingsBound = false;
let toolsRegistered = false;

const settings = () => extension_settings.hindsight;
const hindsightUrl = () => String(settings()?.hindsightUrl || '').replace(/\/+$/, '');
const providerUrl = () => String(settings()?.providerUrl || '').replace(/\/+$/, '');

function readiness() {
    return getReadiness({
        enabled: settings()?.enabled,
        hindsightUrl: hindsightUrl(),
        providerUrl: providerUrl(),
        providerApiKey: settings()?.providerApiKey,
    });
}

function currentChatId() {
    return String(getCurrentChatId?.() || chat_metadata?.chat_id || getContext()?.chatId || 'current-chat');
}

function currentChatName() {
    let details = null;
    try {
        if (typeof getCurrentChatDetails === 'function') {
            details = getCurrentChatDetails();
        }
    } catch {
        // ignore if not available in older ST versions
    }
    return deriveChatLabel({
        chatDetails: details,
        chatMetadata: chat_metadata,
        context: getContext(),
        chatId: currentChatId(),
    });
}

function currentCharacter() {
    return resolveCurrentCharacter({
        context: getContext(),
        this_chid,
        characters,
    });
}

function activeBank() {
    return resolveBankIdentity({
        bankMode: settings().bankMode,
        chatId: currentChatId(),
        chatName: currentChatName(),
        character: currentCharacter(),
        customBankId: settings().customBankId || settings().bankId,
    });
}

function activeBankId() {
    return activeBank().bankId;
}

function status(text, type = '') {
    const el = $('#hindsight_status');
    el.text(text || '');
    el.toggleClass('ready', type === 'ready').toggleClass('error', type === 'error');
    $('#hindsight_settings .status_text').text(readiness().isMemoryReady ? 'ready' : 'off');
    updateUiState();
}

function apiHeaders() {
    return { 'Content-Type': 'application/json' };
}

async function hindsightFetch(path, options = {}, timeout = 90000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(`${hindsightUrl()}${path}`, {
            ...options,
            headers: { ...apiHeaders(), ...(options.headers || {}) },
            signal: controller.signal,
        });
        const text = await response.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
        if (!response.ok) throw new Error(`${response.status}: ${data?.detail || data?.message || text || response.statusText}`);
        return data;
    } finally {
        clearTimeout(timer);
    }
}

function getMemoryMetadata() {
    if (!chat_metadata) return null;
    const meta = chat_metadata[METADATA_KEY];
    if (meta && typeof meta === 'object' && meta.version === 1) return meta;
    return null;
}

function saveMemoryMetadata(metadata, expectedSnapshot = null) {
    if (!chat_metadata) return false;
    if (expectedSnapshot) {
        const currentSnapshot = createChatSnapshot({
            chatId: currentChatId(),
            bankId: activeBank().bankId,
            messages: Array.isArray(chat) ? chat : [],
        });
        if (!canSaveMetadata(expectedSnapshot, currentSnapshot)) {
            console.warn('[Hindsight] Chat changed before metadata save; discarding stale metadata.');
            return false;
        }
    }
    chat_metadata[METADATA_KEY] = metadata;
    saveMetadataDebounced?.();
    updateUiState();
    return true;
}

function updateUiState() {
    const bank = activeBank();
    const meta = getMemoryMetadata();
    const isCompat = isMetadataCompatible(meta, { bankId: bank.bankId, mode: bank.mode, chatId: currentChatId() });
    const segments = isCompat ? (meta?.segments || []) : [];
    const openSeg = segments.find(s => s.status === 'open') || segments[segments.length - 1];
    const totalMsgs = segments.reduce((sum, s) => sum + (s.messageCount || 0), 0);
    const currIdx = openSeg ? (segments.indexOf(openSeg) + 1) : segments.length;
    const activeThreshold = openSeg?.thresholdUsed || settings().messagesPerDocument;

    const stats = formatUiStatus({
        bankLabel: bank.bankLabel,
        mode: bank.mode,
        segmentCount: segments.length,
        currentSegmentIndex: currIdx,
        currentSegmentMessages: openSeg?.messageCount || 0,
        messagesPerDocument: activeThreshold,
        totalIndexedMessages: totalMsgs,
    });

    $('#hindsight_stat_bank').text(stats.activeBankText);
    $('#hindsight_stat_docs').text(stats.docCountText);
    $('#hindsight_stat_curr_doc').text(stats.currentDocText);
    $('#hindsight_stat_total').text(stats.totalIndexedText);
}

async function automaticRecall() {
    if (!readiness().isMemoryReady || settings().recallMode === 'off') return;
    const currentChat = Array.isArray(chat) ? chat : [];
    const query = queryTextForMessages(currentChat);
    const bank = activeBank();
    const chatId = currentChatId();
    const snapshotBefore = createChatSnapshot({ chatId, bankId: bank.bankId, messages: currentChat });
    const key = `${bank.bankId}:${currentChat.length}:${query.slice(-160)}`;
    if (key === recallGenerationKey) return;
    recallGenerationKey = key;
    try {
        const endpoints = buildModelEndpoints(bank.bankId);
        const path = settings().recallMode === 'reflect' ? endpoints.reflect : endpoints.recall;
        const payload = settings().recallMode === 'reflect'
            ? buildReflectPayload({ query, budget: settings().budget, maxTokens: settings().maxTokens })
            : buildRecallPayload({ query, budget: settings().budget, maxTokens: settings().maxTokens });
        const data = await hindsightFetch(path, { method: 'POST', body: JSON.stringify(payload) });

        // Post-fetch race safety check: verify chat/bank/messages didn't switch while waiting
        const snapshotAfter = createChatSnapshot({
            chatId: currentChatId(),
            bankId: activeBank().bankId,
            messages: Array.isArray(chat) ? chat : [],
        });
        if (!isSnapshotCurrent(snapshotBefore, snapshotAfter)) {
            console.log('[Hindsight] Chat or bank switched during recall fetch; discarding stale recall response.');
            return;
        }

        const text = settings().recallMode === 'reflect' ? String(data?.text || '') : formatRecall(data);
        const formatted = text.trim() ? `# Hindsight Memory\nUse this relevant long-term memory when answering.\n\n${text.trim()}` : '';
        const position = Number(settings().injectionPosition);
        setExtensionPrompt(MODULE, formatted, formatted ? position : extension_prompt_types.NONE, position === extension_prompt_types.IN_CHAT ? Number(settings().injectionDepth) || 4 : 0);
        status(formatted ? 'Recall injected' : 'No relevant memory', 'ready');
    } catch (error) {
        console.warn('[Hindsight] automatic recall failed:', error);
        status(`Recall failed: ${error.message}`, 'error');
    }
}

async function retainCurrentChat() {
    if (!readiness().isMemoryReady) return;
    const currentChat = Array.isArray(chat) ? chat : [];
    const existingMeta = getMemoryMetadata();
    // If chat is empty and there is no compatible metadata to clean up, return early
    if (!currentChat.length && (!existingMeta || !existingMeta.segments?.length)) return;
    if (retainInFlight) { retainQueued = true; return; }
    retainInFlight = true;
    try {
        const bank = activeBank();
        const chatId = currentChatId();
        const snapshot = createChatSnapshot({ chatId, bankId: bank.bankId, messages: currentChat });

        const plan = computeSegmentPlan({
            messages: currentChat,
            existingMetadata: existingMeta,
            chatId,
            bankId: bank.bankId,
            bankLabel: bank.bankLabel,
            mode: bank.mode,
            identity: bank.identity,
            messagesPerDocument: settings().messagesPerDocument,
        });

        if (plan.actions.length > 0) {
            const endpoints = buildModelEndpoints(bank.bankId);
            const matchingMeta = isMetadataCompatible(existingMeta, { bankId: bank.bankId, mode: bank.mode, chatId })
                ? normalizeMetadata(existingMeta)
                : null;

            let rollingBase = matchingMeta || {
                version: 1,
                chatId: plan.metadata.chatId,
                bankId: plan.metadata.bankId,
                bankLabel: plan.metadata.bankLabel,
                mode: plan.metadata.mode,
                identity: plan.metadata.identity,
                activeSegmentId: '',
                totalCount: 0,
                currentCount: 0,
                segments: [],
            };
            for (const act of plan.actions) {
                // Pre-fetch race check
                const activeNow = createChatSnapshot({
                    chatId: currentChatId(),
                    bankId: activeBank().bankId,
                    messages: Array.isArray(chat) ? chat : [],
                });
                if (!isSnapshotCurrent(snapshot, activeNow)) {
                    console.log('[Hindsight] Chat state switched mid-retain before network call; aborting outdated retain.');
                    return;
                }

                const target = resolveNetworkActionTarget(endpoints, act);
                if (act.type === 'delete') {
                    await hindsightFetch(target.url, { method: target.method }, 30000);
                } else {
                    const payload = buildRetainPayload({
                        messages: act.messages,
                        documentId: act.documentId,
                        updateMode: act.type,
                        chatId,
                        bankId: bank.bankId,
                    });
                    await hindsightFetch(target.url, { method: target.method, body: JSON.stringify(payload) }, 30000);
                }

                // Immediately acknowledge accepted network action in local rolling metadata to prevent duplicate appends on subsequent retries
                rollingBase = acknowledgeSegmentAction(rollingBase || plan.metadata, act, currentChat);
            }

            // Post-network race check before saving metadata
            const finalState = createChatSnapshot({
                chatId: currentChatId(),
                bankId: activeBank().bankId,
                messages: Array.isArray(chat) ? chat : [],
            });
            if (!isSnapshotCurrent(snapshot, finalState)) {
                console.log('[Hindsight] Chat state changed during retain network operations; discarding stale metadata update.');
                return;
            }

            if (!saveMemoryMetadata(rollingBase || plan.metadata, snapshot)) {
                status('Chat changed before metadata save; retry pending', 'error');
                return;
            }
            status(`Chat saved (${plan.actions.length} seg update)`, 'ready');
        } else {
            status('Chat memory up to date', 'ready');
        }
    } catch (error) {
        console.warn('[Hindsight] retain failed:', error);
        status(`Save failed: ${error.message}`, 'error');
    } finally {
        retainInFlight = false;
        if (retainQueued) {
            retainQueued = false;
            scheduleRetain();
        }
    }
}

function scheduleRetain() {
    if (!readiness().isMemoryReady) return;
    clearTimeout(retainTimer);
    retainTimer = setTimeout(() => retainCurrentChat(), 1200);
}

function registerTools() {
    if (toolsRegistered) return;
    const context = getContext();
    if (!context?.registerFunctionTool) return;
    toolsRegistered = true;
    const shouldRegister = () => readiness().isMemoryReady;

    context.registerFunctionTool({
        name: 'hindsight_recall', displayName: 'Hindsight: Recall',
        description: 'Search long-term Hindsight memory for relevant facts, events, preferences, relationships, and prior conversation details.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for.' } }, required: ['query'] },
        action: async args => {
            if (!readiness().isMemoryReady || !args?.query) return 'Hindsight is not ready or no query was provided.';
            const bank = activeBank();
            const endpoints = buildModelEndpoints(bank.bankId);
            const query = String(args.query).slice(0, MAX_QUERY_CHARS);
            const payload = settings().recallMode === 'reflect'
                ? buildReflectPayload({ query, budget: settings().budget, maxTokens: settings().maxTokens })
                : buildRecallPayload({ query, budget: settings().budget, maxTokens: settings().maxTokens });
            const endpoint = settings().recallMode === 'reflect' ? endpoints.reflect : endpoints.recall;
            const data = await hindsightFetch(endpoint, { method: 'POST', body: JSON.stringify(payload) });
            return settings().recallMode === 'reflect' ? (String(data?.text || '') || 'No relevant memories found.') : (formatRecall(data) || 'No relevant memories found.');
        },
        formatMessage: () => 'Hindsight recall...', shouldRegister, stealth: false,
    });

    context.registerFunctionTool({
        name: 'hindsight_reflect', displayName: 'Hindsight: Reflect',
        description: 'Synthesize a reasoned answer across Hindsight memories. Use for complex continuity, relationships, contradictions, or multi-memory questions.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'The question to synthesize.' } }, required: ['query'] },
        action: async args => {
            if (!readiness().isMemoryReady || !args?.query) return 'Hindsight is not ready or no query was provided.';
            const bank = activeBank();
            const endpoints = buildModelEndpoints(bank.bankId);
            const payload = buildReflectPayload({ query: String(args.query).slice(0, MAX_QUERY_CHARS), budget: settings().budget, maxTokens: settings().maxTokens });
            const data = await hindsightFetch(endpoints.reflect, { method: 'POST', body: JSON.stringify(payload) }, 90000);
            return String(data?.text || 'No relevant memories found.');
        },
        formatMessage: () => 'Hindsight reflect...', shouldRegister, stealth: false,
    });

    context.registerFunctionTool({
        name: 'hindsight_retain', displayName: 'Hindsight: Save Memory',
        description: 'Store an explicit durable fact, preference, decision, or continuity detail in Hindsight long-term memory.',
        parameters: { type: 'object', properties: { content: { type: 'string', description: 'Durable information to store.' }, context: { type: 'string', description: 'Short context label.' } }, required: ['content'] },
        action: async args => {
            if (!readiness().isMemoryReady || !args?.content) return 'Hindsight is not ready or no content was provided.';
            const bank = activeBank();
            const endpoints = buildModelEndpoints(bank.bankId);
            const retainPayload = buildExplicitRetainPayload({
                content: String(args.content).slice(0, MAX_QUERY_CHARS),
                context: args.context || 'explicit model memory',
            });
            await hindsightFetch(endpoints.memories, { method: 'POST', body: JSON.stringify(retainPayload) }, 30000);
            return 'Memory stored successfully.';
        },
        formatMessage: () => 'Hindsight saving to memory...', shouldRegister, stealth: false,
    });
}

async function loadPersistedModel() {
    if (!readiness().isBackendReachable) return;
    try {
        const endpoints = buildModelEndpoints(activeBankId());
        const data = await hindsightFetch(endpoints.model, { method: 'GET' }, 30000);
        if (data?.model) {
            settings().model = data.model;
            $('#hindsight_model').val(data.model);
            $('#hindsight_model_status').text(`Persisted selection: ${data.model} (${data.source || 'server'})`);
            saveSettingsDebounced();
        }
    } catch (error) {
        console.warn('[Hindsight] model preference load failed:', error);
    }
}

async function saveSelectedModel() {
    const model = settings().model || 'auto';
    if (model === 'auto' || !readiness().isBackendReachable) return;
    if (!readiness().isProviderReady) {
        $('#hindsight_model_status').text('Provider base URL and API key required to save model config');
        return;
    }
    try {
        const endpoints = buildModelEndpoints(activeBankId());
        await hindsightFetch(endpoints.provider, { method: 'PATCH', body: JSON.stringify({
            base_url: providerUrl(), api_key: settings().providerApiKey, model, provider: settings().provider || 'openai',
        }) });
        await hindsightFetch(endpoints.model, { method: 'PATCH', body: JSON.stringify({ model }) });
        $('#hindsight_model_status').text(`Persisted selection: ${model}`);
        status(`Model selected: ${model}`, 'ready');
    } catch (error) {
        console.warn('[Hindsight] model preference save failed:', error);
        $('#hindsight_model_status').text(`Model save failed: ${error.message}`);
    }
}

async function refreshBanks() {
    if (!readiness().isBackendReachable) {
        status('Configure backend URL first to list banks', 'error');
        return;
    }
    try {
        const data = await hindsightFetch('/v1/default/banks?limit=100', { method: 'GET' }, 30000);
        const banks = parseBanksResponse(data);
        settings().discoveredBanks = banks;
        populateCustomBanksSelect(banks);
        saveSettingsDebounced();
        status(`Discovered ${banks.length} banks`, 'ready');
    } catch (error) {
        console.warn('[Hindsight] failed to list banks:', error);
        status(`List banks failed: ${error.message}`, 'error');
    }
}

function populateCustomBanksSelect(banks) {
    const select = $('#hindsight_custom_bank_select').empty();
    select.append($('<option value="">-- Choose existing bank --</option>'));
    const list = Array.isArray(banks) && banks.length ? banks : (settings().discoveredBanks || []);
    list.forEach(b => select.append($('<option>').val(b).text(b)));
    const current = settings().customBankId || settings().bankId || '';
    if (current) select.val(current);
}

async function discoverModels() {
    const output = $('#hindsight_model_status');
    if (!readiness().isProviderReady) {
        output.text('Provider base URL and API key required to discover models.');
        return;
    }
    output.text('Discovering provider models...');
    try {
        const response = await fetch(`${providerUrl()}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${settings().providerApiKey}` },
        });
        const text = await response.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            const preview = String(text || '').replace(/\s+/g, ' ').slice(0, 180);
            throw new Error(`${response.status}: provider returned non-JSON${preview ? ` (${preview})` : ''}`);
        }
        if (!response.ok) throw new Error(`${response.status}: ${data?.error?.message || data?.detail || text || response.statusText}`);
        const models = (data?.data || data?.models || []).map(x => typeof x === 'string' ? x : x.id).filter(Boolean);
        const select = $('#hindsight_model').empty().append('<option value="auto">Auto / provider-selected</option>');
        models.forEach(model => select.append($('<option>').val(model).text(model)));
        if (models.includes(settings().model)) select.val(settings().model); else select.val('auto');
        settings().discoveredModels = models;
        settings().model = select.val();
        saveSettingsDebounced();
        output.text(models.length ? `${models.length} provider models found.` : 'No provider model catalog exposed; enter a model manually.');
    } catch (error) {
        $('#hindsight_model').empty().append('<option value="auto">Auto / provider-selected</option>');
        output.text(`Provider model discovery unavailable: ${error.message}`);
    }
}

async function testHindsightConnection() {
    const output = $('#hindsight_connection_status');
    output.text('Testing Hindsight...');
    try {
        const response = await fetch(`${hindsightUrl()}/openapi.json`, { method: 'GET', headers: { Accept: 'application/json' } });
        const text = await response.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`${response.status}: backend returned non-JSON`); }
        const title = String(data?.info?.title || '').toLowerCase();
        if (!response.ok) throw new Error(`${response.status}: ${data?.detail || 'request failed'}`);
        if (!title.includes('hindsight')) throw new Error('endpoint is live but does not identify as Hindsight');
        output.text(`Hindsight live: ${data.info.title} ${data.info.version || ''}`.trim());
        status('Hindsight connection OK', 'ready');
        await refreshBanks();
    } catch (error) {
        output.text(`Hindsight connection failed: ${error.message}`);
        status('Hindsight connection failed', 'error');
    }
}

function loadUi() {
    $('#hindsight_enabled').prop('checked', settings().enabled);
    $('#hindsight_url').val(settings().hindsightUrl);
    $('#hindsight_provider_url').val(settings().providerUrl);
    $('#hindsight_provider_key').val(settings().providerApiKey);
    $('#hindsight_bank_mode').val(settings().bankMode || 'auto');
    $('#hindsight_bank_id').val(settings().customBankId || settings().bankId || '');
    $('#hindsight_messages_per_document').val(settings().messagesPerDocument || 15);
    $('#hindsight_recall_mode').val(settings().recallMode);
    $('#hindsight_budget').val(settings().budget);

    $('#hindsight_custom_bank_container').toggle(settings().bankMode === 'custom');
    populateCustomBanksSelect(settings().discoveredBanks);

    const select = $('#hindsight_model').empty().append('<option value="auto">Auto / server-selected</option>');
    (settings().discoveredModels || []).forEach(model => select.append($('<option>').val(model).text(model)));
    select.val(settings().model || 'auto');
    status(readiness().isMemoryReady ? 'Ready' : 'Configure URL and enable', readiness().isMemoryReady ? 'ready' : '');
    updateUiState();
}

function bindUi() {
    if (settingsBound) return;
    settingsBound = true;
    const save = () => { saveSettingsDebounced(); loadUi(); registerTools(); };

    $('#hindsight_enabled').on('change', function() { settings().enabled = $(this).prop('checked'); save(); });
    $('#hindsight_url').on('change', function() { settings().hindsightUrl = $(this).val().trim().replace(/\/+$/, ''); save(); });
    $('#hindsight_provider_url').on('change', function() { settings().providerUrl = $(this).val().trim().replace(/\/+$/, ''); save(); });
    $('#hindsight_provider_key').on('change', function() { settings().providerApiKey = $(this).val().trim(); save(); });

    $('#hindsight_bank_mode').on('change', function() {
        settings().bankMode = $(this).val();
        $('#hindsight_custom_bank_container').toggle(settings().bankMode === 'custom');
        recallGenerationKey = '';
        save();
    });

    $('#hindsight_custom_bank_select').on('change', function() {
        const val = $(this).val();
        if (val) {
            settings().customBankId = val;
            settings().bankId = val;
            $('#hindsight_bank_id').val(val);
            recallGenerationKey = '';
            save();
        }
    });

    $('#hindsight_bank_id').on('change', function() {
        const val = $(this).val().trim();
        settings().customBankId = val;
        settings().bankId = val;
        recallGenerationKey = '';
        save();
    });

    $('#hindsight_messages_per_document').on('change', function() {
        const num = Math.max(1, parseInt($(this).val(), 10) || 15);
        settings().messagesPerDocument = num;
        save();
    });

    $('#hindsight_refresh_banks').on('click', refreshBanks);
    $('#hindsight_recall_mode').on('change', function() { settings().recallMode = $(this).val(); save(); });
    $('#hindsight_budget').on('change', function() { settings().budget = $(this).val(); save(); });
    $('#hindsight_model').on('change', async function() { settings().model = $(this).val(); saveSettingsDebounced(); await saveSelectedModel(); });
    $('#hindsight_discover_models').on('click', discoverModels);
    $('#hindsight_test_connection').on('click', testHindsightConnection);
}

async function loadSettingsHtml() {
    const url = new URL('./settings.html', import.meta.url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load settings: ${response.status}`);
    return response.text();
}

function onChatChanged() {
    recallGenerationKey = '';
    setExtensionPrompt(MODULE, '', extension_prompt_types.NONE, 0);
    updateUiState();
}

function onMessageMutation() {
    recallGenerationKey = '';
    scheduleRetain();
}

jQuery(async () => {
    extension_settings.hindsight = Object.assign({}, DEFAULTS, extension_settings.hindsight || {});
    $('#extensions_settings2').append(await loadSettingsHtml());
    loadUi();
    bindUi();
    registerTools();
    await loadPersistedModel();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, automaticRecall);
    eventSource.on(event_types.MESSAGE_SENT, onMessageMutation);
    if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, onMessageMutation);
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, onMessageMutation);
    if (event_types.MESSAGE_UPDATED) eventSource.on(event_types.MESSAGE_UPDATED, onMessageMutation);
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, onMessageMutation);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onMessageMutation);
    console.log('[Hindsight] extension loaded (bank-mode + segmented-doc enabled)');
});
