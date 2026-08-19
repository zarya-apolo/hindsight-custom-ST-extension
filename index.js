import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    getCurrentChatId,
    chat_metadata,
    chat,
} from '../../../../script.js';
import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';

const MODULE = 'hindsight';
const DEFAULTS = {
    enabled: false,
    hindsightUrl: '',
    providerUrl: '',
    providerApiKey: '',
    bankId: 'sillytavern',
    model: 'auto',
    scope: 'global',
    recallMode: 'recall',
    budget: 'mid',
    maxTokens: 2200,
    injectionPosition: extension_prompt_types.IN_PROMPT,
    injectionDepth: 4,
};
const MAX_QUERY_CHARS = 8000;
const MAX_CONTENT_CHARS = 120000;
let retainTimer = null;
let retainInFlight = false;
let retainQueued = false;
let recallGenerationKey = '';
let settingsBound = false;

const settings = () => extension_settings.hindsight;
const hindsightUrl = () => String(settings()?.hindsightUrl || '').replace(/\/+$/, '');
const providerUrl = () => String(settings()?.providerUrl || '').replace(/\/+$/, '');
const bankId = () => encodeURIComponent(String(settings()?.bankId || 'sillytavern').trim() || 'sillytavern');
const modelEndpoint = () => `/v1/default/banks/${bankId()}/llm-model`;
const modelsEndpoint = '/v1/models';
const providerEndpoint = () => `/v1/default/banks/${bankId()}/llm-provider`;
const ready = () => Boolean(settings()?.enabled && hindsightUrl() && providerUrl() && settings()?.providerApiKey);

function status(text, type = '') {
    const el = $('#hindsight_status');
    el.text(text || '');
    el.toggleClass('ready', type === 'ready').toggleClass('error', type === 'error');
    $('#hindsight_settings .status_text').text(ready() ? 'ready' : 'off');
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

function sanitize(value, fallback = 'unknown') {
    const result = String(value || '').trim().replace(/[^a-zA-Z0-9._:-]+/g, '_').replace(/^_+|_+$/g, '');
    return result || fallback;
}

function currentChatId() {
    return String(getCurrentChatId?.() || chat_metadata?.chat_id || 'current-chat');
}

function characterScope() {
    const context = getContext();
    const character = context?.name2 || context?.characterName || context?.characters?.[context?.characterId]?.name || 'character';
    return sanitize(character, 'character');
}

function scopeTags() {
    const mode = settings().scope;
    if (mode === 'chat') return [`st:chat:${sanitize(currentChatId())}`];
    if (mode === 'character') return [`st:character:${characterScope()}`];
    return [];
}

function documentId() {
    return `st-chat:${sanitize(currentChatId())}`;
}

function messageText(message) {
    if (!message || message.is_system) return '';
    const role = message.is_user ? 'User' : (message.name || 'Assistant');
    const text = String(message.mes || message.content || '').trim();
    if (!text) return '';
    const stamp = message.send_date || message.created_at || '';
    return `${role}${stamp ? ` (${stamp})` : ''}: ${text}`;
}

function conversationText() {
    return (Array.isArray(chat) ? chat : []).map(messageText).filter(Boolean).join('\n\n').slice(-MAX_CONTENT_CHARS);
}

function queryText() {
    const messages = (Array.isArray(chat) ? chat : []).filter(x => x && !x.is_system).slice(-8);
    const current = messages.map(messageText).filter(Boolean).join('\n');
    return current.slice(-MAX_QUERY_CHARS) || 'What durable facts, preferences, relationships, or events are relevant to this conversation?';
}

function recallPayload() {
    const payload = {
        query: queryText(),
        budget: settings().budget || 'mid',
        max_tokens: Number(settings().maxTokens) || 2200,
        types: ['observation', 'world', 'experience'],
        prefer_observations: true,
    };
    const tags = scopeTags();
    if (tags.length) { payload.tags = tags; payload.tags_match = 'any_strict'; }
    return payload;
}

function formatRecall(data) {
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) return '';
    return results.map(item => `- ${item.text || ''}`).filter(Boolean).join('\n');
}

async function automaticRecall() {
    if (!ready() || settings().recallMode === 'off') return;
    const key = `${currentChatId()}:${chat?.length || 0}:${queryText().slice(-160)}`;
    if (key === recallGenerationKey) return;
    recallGenerationKey = key;
    try {
        const path = settings().recallMode === 'reflect'
            ? `/v1/default/banks/${bankId()}/reflect`
            : `/v1/default/banks/${bankId()}/memories/recall`;
        const payload = recallPayload();
        payload.query = queryText();
        const data = await hindsightFetch(path, { method: 'POST', body: JSON.stringify(payload) });
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
    if (!ready()) return;
    const content = conversationText();
    if (!content) return;
    if (retainInFlight) { retainQueued = true; return; }
    retainInFlight = true;
    try {
        const payload = {
            items: [{
                content,
                document_id: documentId(),
                update_mode: 'replace',
                context: 'SillyTavern roleplay/chat conversation',
                metadata: { source: 'sillytavern-hindsight-extension', chat_id: currentChatId() },
                tags: scopeTags(),
            }],
        };
        payload.async = true;
        await hindsightFetch(`/v1/default/banks/${bankId()}/memories`, { method: 'POST', body: JSON.stringify(payload) }, 30000);
        status('Chat saved to Hindsight', 'ready');
    } catch (error) {
        console.warn('[Hindsight] retain failed:', error);
        status(`Save failed: ${error.message}`, 'error');
    } finally {
        retainInFlight = false;
        if (retainQueued) { retainQueued = false; scheduleRetain(); }
    }
}

function scheduleRetain() {
    if (!ready()) return;
    clearTimeout(retainTimer);
    retainTimer = setTimeout(() => retainCurrentChat(), 1200);
}

function toolScopePayload(payload) {
    const tags = scopeTags();
    if (tags.length) { payload.tags = tags; payload.tags_match = 'any_strict'; }
    return payload;
}

function registerTools() {
    const context = getContext();
    const shouldRegister = () => ready();
    context.registerFunctionTool({
        name: 'hindsight_recall', displayName: 'Hindsight: Recall',
        description: 'Search long-term Hindsight memory for relevant facts, events, preferences, relationships, and prior conversation details.',
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to search for.' } }, required: ['query'] },
        action: async args => {
            if (!ready() || !args?.query) return 'Hindsight is not ready or no query was provided.';
            const payload = settings().recallMode === 'reflect'
                ? toolScopePayload({ query: String(args.query).slice(0, MAX_QUERY_CHARS), budget: settings().budget, max_tokens: Number(settings().maxTokens) || 2200 })
                : toolScopePayload({ query: String(args.query).slice(0, MAX_QUERY_CHARS), budget: settings().budget, max_tokens: Number(settings().maxTokens) || 2200, types: ['observation', 'world', 'experience'], prefer_observations: true });
            const endpoint = settings().recallMode === 'reflect' ? `/v1/default/banks/${bankId()}/reflect` : `/v1/default/banks/${bankId()}/memories/recall`;
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
            if (!ready() || !args?.query) return 'Hindsight is not ready or no query was provided.';
            const payload = toolScopePayload({ query: String(args.query).slice(0, MAX_QUERY_CHARS), budget: settings().budget, max_tokens: Number(settings().maxTokens) || 2200 });
            const data = await hindsightFetch(`/v1/default/banks/${bankId()}/reflect`, { method: 'POST', body: JSON.stringify(payload) }, 120000);
            return String(data?.text || 'No relevant memories found.');
        },
        formatMessage: () => 'Hindsight reflect...', shouldRegister, stealth: false,
    });
    context.registerFunctionTool({
        name: 'hindsight_retain', displayName: 'Hindsight: Save Memory',
        description: 'Store an explicit durable fact, preference, decision, or continuity detail in Hindsight long-term memory.',
        parameters: { type: 'object', properties: { content: { type: 'string', description: 'Durable information to store.' }, context: { type: 'string', description: 'Short context label.' } }, required: ['content'] },
        action: async args => {
            if (!ready() || !args?.content) return 'Hindsight is not ready or no content was provided.';
            const item = { content: String(args.content).slice(0, MAX_QUERY_CHARS), context: args.context || 'explicit model memory', tags: scopeTags() };
            const retainPayload = { items: [item], async: true };
            await hindsightFetch(`/v1/default/banks/${bankId()}/memories`, { method: 'POST', body: JSON.stringify(retainPayload) }, 30000);
            return 'Memory stored successfully.';
        },
        formatMessage: () => 'Hindsight saving to memory...', shouldRegister, stealth: false,
    });
}

async function loadPersistedModel() {
    if (!ready()) return;
    try {
        const data = await hindsightFetch(modelEndpoint(), { method: 'GET' }, 30000);
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
    if (model === 'auto' || !ready()) return;
    try {
        await hindsightFetch(providerEndpoint(), { method: 'PATCH', body: JSON.stringify({
            base_url: providerUrl(), api_key: settings().providerApiKey, model, provider: settings().provider || 'openai',
        }) });
        await hindsightFetch(modelEndpoint(), { method: 'PATCH', body: JSON.stringify({ model }) });
        $('#hindsight_model_status').text(`Persisted selection: ${model}`);
        status(`Model selected: ${model}`, 'ready');
    } catch (error) {
        console.warn('[Hindsight] model preference save failed:', error);
        $('#hindsight_model_status').text(`Model save failed: ${error.message}`);
    }
}

async function discoverModels() {
    const output = $('#hindsight_model_status');
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
    $('#hindsight_bank_id').val(settings().bankId);
    $('#hindsight_scope').val(settings().scope);
    $('#hindsight_recall_mode').val(settings().recallMode);
    $('#hindsight_budget').val(settings().budget);
    const select = $('#hindsight_model').empty().append('<option value="auto">Auto / server-selected</option>');
    (settings().discoveredModels || []).forEach(model => select.append($('<option>').val(model).text(model)));
    select.val(settings().model || 'auto');
    status(ready() ? 'Ready' : 'Configure URL and key', ready() ? 'ready' : '');
}

function bindUi() {
    if (settingsBound) return;
    settingsBound = true;
    const save = () => { saveSettingsDebounced(); loadUi(); registerTools(); };
    $('#hindsight_enabled').on('change', function() { settings().enabled = $(this).prop('checked'); save(); });
    $('#hindsight_url').on('change', function() { settings().hindsightUrl = $(this).val().trim().replace(/\/+$/, ''); save(); });
    $('#hindsight_provider_url').on('change', function() { settings().providerUrl = $(this).val().trim().replace(/\/+$/, ''); save(); });
    $('#hindsight_provider_key').on('change', function() { settings().providerApiKey = $(this).val().trim(); save(); });
    $('#hindsight_bank_id').on('change', function() { settings().bankId = $(this).val().trim(); save(); });
    $('#hindsight_scope').on('change', function() { settings().scope = $(this).val(); save(); });
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
    if (ready()) scheduleRetain();
}
function onMessageMutation() { recallGenerationKey = ''; scheduleRetain(); }

jQuery(async () => {
    extension_settings.hindsight = Object.assign({}, DEFAULTS, extension_settings.hindsight || {});
    $('#extensions_settings2').append(await loadSettingsHtml());
    loadUi(); bindUi(); registerTools();
    await loadPersistedModel();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, automaticRecall);
    eventSource.on(event_types.MESSAGE_SENT, onMessageMutation);
    if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, onMessageMutation);
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, onMessageMutation);
    if (event_types.MESSAGE_UPDATED) eventSource.on(event_types.MESSAGE_UPDATED, onMessageMutation);
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, onMessageMutation);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onMessageMutation);
    console.log('[Hindsight] extension loaded');
});
