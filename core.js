// Pure logic helpers for Hindsight SillyTavern extension
// Node testable without SillyTavern dependencies

export function fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

export function sanitizeBankId(value, fallback = 'unknown') {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    const sanitized = raw
        .replace(/[^a-zA-Z0-9._:-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!sanitized) return fallback;
    if (sanitized === raw) return sanitized;
    // Append collision-resistant deterministic suffix if sanitization changed the raw value
    return `${sanitized}_${fnv1a(raw)}`;
}

export function resolveCurrentCharacter({ context, this_chid, characters } = {}) {
    if (context?.groupId) {
        return null;
    }
    const chid = (this_chid !== undefined && this_chid !== null) ? this_chid : context?.characterId;
    const charObj = (chid !== undefined && chid !== null) ? (characters?.[chid] || context?.characters?.[chid] || {}) : {};
    const exactName = charObj.name || (chid !== undefined && chid !== null ? context?.name2 || context?.characterName : null);
    if (!exactName || !String(exactName).trim()) {
        return null;
    }
    return {
        name: String(exactName).trim(),
        avatar: charObj.avatar || context?.characterAvatar || '',
    };
}

export function formatBankLabel(mode, { chatName, chatId, cardName, customBankId }) {

    if (mode === 'character') {
        return cardName || 'character';
    }
    if (mode === 'custom') {
        return customBankId || 'sillytavern';
    }
    // auto
    const name = String(chatName || 'Chat').trim();
    const id = String(chatId || 'unknown').trim();
    return `${name} (${id})`;
}

export function resolveBankIdentity({ bankMode, chatId, chatName, character, customBankId }) {
    const mode = ['auto', 'character', 'custom'].includes(bankMode) ? bankMode : 'auto';
    const cId = String(chatId || 'current-chat');
    const cName = String(chatName || 'Chat').trim();

    if (mode === 'character') {
        const cardName = character?.name || character?.characterName;
        if (!cardName || !String(cardName).trim()) {
            // No card/character name (e.g. group chat or no card loaded) -> fail safe to Auto
            return resolveBankIdentity({ bankMode: 'auto', chatId: cId, chatName: cName, character: null, customBankId });
        }
        const exactCard = String(cardName).trim();
        const rawAvatar = character?.avatar || character?.characterId || '';
        return {
            mode: 'character',
            bankId: exactCard,
            bankLabel: exactCard,
            identity: { kind: 'card', value: exactCard, avatar: rawAvatar },
        };
    }
    if (mode === 'custom') {
        const exactBank = String(customBankId || 'sillytavern').trim() || 'sillytavern';
        return {
            mode: 'custom',
            bankId: exactBank,
            bankLabel: exactBank,
            identity: { kind: 'custom', value: exactBank },
        };
    }
    // auto
    const safeId = sanitizeBankId(cId, 'current-chat');
    const bankId = `st-chat-${safeId}`;
    const bankLabel = formatBankLabel('auto', { chatName: cName, chatId: cId });
    return {
        mode: 'auto',
        bankId,
        bankLabel,
        identity: { kind: 'chat', value: cId },
    };
}

export function buildModelEndpoints(bankId) {
    const encoded = encodeURIComponent(String(bankId || 'sillytavern').trim());
    return {
        model: `/v1/default/banks/${encoded}/llm-model`,
        reflectModel: `/v1/default/banks/${encoded}/reflect-llm-model`,
        provider: `/v1/default/banks/${encoded}/llm-provider`,
        memories: `/v1/default/banks/${encoded}/memories`,
        recall: `/v1/default/banks/${encoded}/memories/recall`,
        reflect: `/v1/default/banks/${encoded}/reflect`,
        document: (docId) => `/v1/default/banks/${encoded}/documents/${encodeURIComponent(String(docId || '').trim())}`,
    };
}

export function resolveNetworkActionTarget(endpoints, action) {
    if (!endpoints || !action) return null;
    if (action.type === 'delete') {
        return {
            method: 'DELETE',
            url: endpoints.document(action.documentId),
            isBankDelete: false,
        };
    }
    return {
        method: 'POST',
        url: endpoints.memories,
        isBankDelete: false,
    };
}

export function getReadiness({ enabled, hindsightUrl, providerUrl, providerApiKey }) {

    const hUrl = String(hindsightUrl || '').trim();
    const pUrl = String(providerUrl || '').trim();
    const pKey = String(providerApiKey || '').trim();
    const isBackendReachable = Boolean(hUrl);
    const isMemoryReady = Boolean(enabled && hUrl);
    const isProviderReady = Boolean(pUrl && pKey);
    return {
        isMemoryReady,
        isProviderReady,
        isBackendReachable,
        isFullyConfigured: Boolean(isMemoryReady && isProviderReady),
    };
}

export function parseBanksResponse(data) {
    if (!data) return [];
    const list = Array.isArray(data) ? data : (Array.isArray(data.banks) ? data.banks : (Array.isArray(data.items) ? data.items : []));
    return list.map(item => {
        if (typeof item === 'string') return item;
        return item?.bank_id || item?.id || item?.name || '';
    }).filter(Boolean);
}

export function messageKey(message, index = 0) {
    if (!message) return `msg_${index}`;
    if (message.mesId !== undefined && message.mesId !== null) return String(message.mesId);
    if (message.id !== undefined && message.id !== null) return String(message.id);
    const stamp = message.send_date || message.created_at;
    if (stamp) {
        const role = message.is_user ? 'user' : (message.name || 'assistant');
        return `${role}_${stamp}`;
    }
    const role = message.is_user ? 'u' : 'a';
    return `msg_${index}_${role}`;
}

export function messageKeys(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const occurrences = new Map();
    return list.map((message, index) => {
        if (!message) return `msg_${index}`;
        if (message.mesId !== undefined && message.mesId !== null) return String(message.mesId);
        if (message.id !== undefined && message.id !== null) return String(message.id);
        const stamp = message.send_date || message.created_at;
        if (stamp) {
            const role = message.is_user ? 'user' : (message.name || 'assistant');
            const base = `${role}_${stamp}`;
            const count = occurrences.get(base) || 0;
            occurrences.set(base, count + 1);
            return `${base}#${count}`;
        }
        const role = message.is_user ? 'u' : 'a';
        return `msg_${index}_${role}`;
    });
}

export function messageFingerprint(message) {
    if (!message) return '';
    const role = message.is_user ? 'User' : (message.name || 'Assistant');
    const text = String(message.mes || message.content || '').trim();
    const stamp = message.send_date || message.created_at || '';
    // ponytail: simple deterministic hash, no crypto dependency
    const raw = `${role}|${stamp}|${text}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
        hash = ((hash << 5) - hash) + raw.charCodeAt(i);
        hash |= 0;
    }
    return `${hash}_${text.length}`;
}

export function segmentFingerprint(messages) {
    return (Array.isArray(messages) ? messages : []).map(messageFingerprint).join(';');
}

export function partitionMessages(messages, threshold = 15) {
    const limit = Math.max(1, Number(threshold) || 15);
    const nonSystem = (Array.isArray(messages) ? messages : []).filter(m => m && !m.is_system && !m.is_hidden && m.mes !== 'tool_call');
    const segments = [];
    for (let i = 0; i < nonSystem.length; i += limit) {
        segments.push(nonSystem.slice(i, i + limit));
    }
    return segments;
}

export function messageText(message) {
    if (!message || message.is_system) return '';
    const role = message.is_user ? 'User' : (message.name || 'Assistant');
    const text = String(message.mes || message.content || '').trim();
    if (!text) return '';
    const stamp = message.send_date || message.created_at || '';
    return `${role}${stamp ? ` (${stamp})` : ''}: ${text}`;
}

export function conversationTextForMessages(messages) {
    return (Array.isArray(messages) ? messages : [])
        .map(messageText)
        .filter(Boolean)
        .join('\n\n');
}

export function queryTextForMessages(messages) {
    const nonSystem = (Array.isArray(messages) ? messages : []).filter(x => x && !x.is_system);
    const recent = nonSystem.slice(-2);
    const text = recent.map(m => String(m.mes || m.content || '').trim()).filter(Boolean).join('\n');
    return text.slice(0, 1000) || 'What durable facts, preferences, relationships, or events are relevant to this conversation?';
}

export function formatRecall(data) {
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) return '';
    return results.map(item => `- ${item.text || ''}`).filter(Boolean).join('\n');
}

export function generateSegmentId(chatId = '', anchorKey = '', ordinal = 0) {
    if (chatId && anchorKey) {
        return `seg_${fnv1a(`${chatId}:${anchorKey}:${ordinal}`)}`;
    }
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `seg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isValidGeneratedDocumentId(documentId, chatId) {
    if (!documentId || typeof documentId !== 'string') return false;
    const safeChatId = sanitizeBankId(chatId, 'chat');
    // st-chat:<sanitized-chat-id>:segment:<segment-id>
    const prefix = `st-chat:${safeChatId}:segment:`;
    if (!documentId.startsWith(prefix)) return false;
    const segId = documentId.slice(prefix.length);
    return Boolean(segId && !segId.includes(':'));
}

export function isMetadataCompatible(existingMetadata, { bankId, mode, chatId }) {
    if (!existingMetadata || typeof existingMetadata !== 'object') return false;
    if (existingMetadata.version !== 1) return false;
    if (!existingMetadata.chatId || !existingMetadata.bankId || !existingMetadata.mode) return false;
    if (!Array.isArray(existingMetadata.segments)) return false;
    const resolvedChatId = chatId || existingMetadata.chatId;
    if (chatId && existingMetadata.chatId !== chatId) return false;
    if (bankId && existingMetadata.bankId !== bankId) return false;
    if (mode && existingMetadata.mode !== mode) return false;

    // Strict validation on every segment: fail closed if any segment is malformed/corrupted
    for (const seg of existingMetadata.segments) {
        if (!seg || typeof seg !== 'object') return false;
        if (!seg.id || typeof seg.id !== 'string') return false;
        if (!seg.documentId || typeof seg.documentId !== 'string') return false;
        if (!isValidGeneratedDocumentId(seg.documentId, resolvedChatId)) return false;
        if (seg.status !== 'open' && seg.status !== 'closed') return false;
        if (typeof seg.messageCount !== 'number' || !Number.isInteger(seg.messageCount) || seg.messageCount < 0) return false;
        if (!Array.isArray(seg.messageIds) || seg.messageIds.length !== seg.messageCount) return false;
        if (!Array.isArray(seg.fingerprints) || seg.fingerprints.length !== seg.messageCount) return false;
        if (typeof seg.fingerprint !== 'string') return false;
    }

    return true;
}

export function normalizeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    return {
        version: 1,
        chatId: metadata.chatId || '',
        bankId: metadata.bankId || '',
        bankLabel: metadata.bankLabel || '',
        mode: metadata.mode || 'auto',
        identity: metadata.identity || { kind: 'chat', value: metadata.chatId || '' },
        activeSegmentId: metadata.activeSegmentId || '',
        totalCount: Number(metadata.totalCount) || 0,
        currentCount: Number(metadata.currentCount) || 0,
        segments: Array.isArray(metadata.segments) ? metadata.segments.map(s => ({
            id: s.id || '',
            documentId: s.documentId || '',
            status: s.status || 'open',
            thresholdUsed: Number(s.thresholdUsed) || 15,
            messageCount: Number(s.messageCount) || 0,
            messageIds: Array.isArray(s.messageIds) ? s.messageIds : [],
            fingerprints: Array.isArray(s.fingerprints) ? s.fingerprints : [],
            fingerprint: s.fingerprint || '',
        })) : [],
    };
}

export function deriveChatLabel({ chatDetails, chatMetadata, context, chatId }) {
    const nameFromDetails = chatDetails?.sessionName || chatDetails?.name || chatDetails?.chat_name || chatDetails?.title;
    if (nameFromDetails && String(nameFromDetails).trim()) {
        return String(nameFromDetails).trim();
    }
    const nameFromMeta = chatMetadata?.sessionName || chatMetadata?.chat_name || chatMetadata?.title || chatMetadata?.name;
    if (nameFromMeta && String(nameFromMeta).trim()) {
        return String(nameFromMeta).trim();
    }
    const idFromContext = context?.chatId || chatId;
    if (idFromContext && String(idFromContext).trim()) {
        return String(idFromContext).trim();
    }
    return 'Chat';
}

export function acknowledgeSegmentAction(metadata, action, fullMessages) {
    if (!action) return metadata;
    // Derive default chatId/bankId from documentId or segmentId if available
    let derivedChatId = metadata?.chatId || '';
    if (!derivedChatId && action?.documentId) {
        const match = String(action.documentId).match(/^st-chat:([^:]+):segment:/);
        if (match) derivedChatId = match[1];
    }
    const derivedBankId = metadata?.bankId || (derivedChatId ? `st-chat-${derivedChatId}` : '');

    const base = normalizeMetadata(metadata) || {
        version: 1,
        chatId: derivedChatId,
        bankId: derivedBankId,
        bankLabel: metadata?.bankLabel || '',
        mode: metadata?.mode || 'auto',
        identity: metadata?.identity || { kind: 'chat', value: derivedChatId },
        activeSegmentId: metadata?.activeSegmentId || '',
        totalCount: metadata?.totalCount || 0,
        currentCount: metadata?.currentCount || 0,
        segments: [],
    };

    if (action.type === 'delete') {
        const remaining = base.segments.filter(s => s.id !== action.segmentId && s.documentId !== action.documentId);
        const activeSeg = remaining[remaining.length - 1] || null;
        const total = remaining.reduce((sum, s) => sum + (s.messageCount || 0), 0);
        return {
            ...base,
            segments: remaining,
            activeSegmentId: activeSeg?.id || '',
            totalCount: total,
            currentCount: activeSeg ? activeSeg.messageCount : 0,
        };
    }

    // Prefer segmentMetadata attached directly to action by computeSegmentPlan
    if (action.segmentMetadata) {
        const segMeta = action.segmentMetadata;
        const segIndex = base.segments.findIndex(s => s.id === action.segmentId || s.documentId === action.documentId);
        const newSegments = [...base.segments];
        if (segIndex >= 0) {
            newSegments[segIndex] = segMeta;
        } else {
            newSegments.push(segMeta);
        }
        const activeSeg = newSegments[newSegments.length - 1] || null;
        const total = newSegments.reduce((sum, s) => sum + (s.messageCount || 0), 0);
        return {
            ...base,
            segments: newSegments,
            activeSegmentId: activeSeg?.id || '',
            totalCount: total,
            currentCount: activeSeg ? activeSeg.messageCount : 0,
        };
    }

    // Fallback if action lacks segmentMetadata
    const nonSystem = (Array.isArray(fullMessages) ? fullMessages : []).filter(m => m && !m.is_system);
    const nonSystemKeys = messageKeys(nonSystem);

    const segIndex = base.segments.findIndex(s => s.id === action.segmentId || s.documentId === action.documentId);
    let targetSeg = segIndex >= 0 ? base.segments[segIndex] : null;

    if (action.type === 'append' && targetSeg) {
        const addedMsgs = Array.isArray(action.messages) ? action.messages : [];
        const addedFps = addedMsgs.map(messageFingerprint);
        // Find slice offset in nonSystem for these added messages
        const prevSegsMsgCount = base.segments.slice(0, segIndex).reduce((sum, s) => sum + (s.messageCount || s.messageIds.length), 0);
        const oldMsgCount = targetSeg.messageCount || targetSeg.messageIds.length;
        const startOffset = prevSegsMsgCount + oldMsgCount;
        const newMsgKeys = nonSystemKeys.slice(startOffset, startOffset + addedMsgs.length);
        const updatedFps = [...targetSeg.fingerprints, ...addedFps];
        const updatedKeys = [...targetSeg.messageIds, ...newMsgKeys];

        const updatedSeg = {
            ...targetSeg,
            messageCount: updatedKeys.length,
            messageIds: updatedKeys,
            fingerprints: updatedFps,
            fingerprint: updatedFps.join(';'),
            status: updatedKeys.length >= (targetSeg.thresholdUsed || 15) ? 'closed' : 'open',
        };

        const newSegments = [...base.segments];
        newSegments[segIndex] = updatedSeg;
        const activeSeg = newSegments[newSegments.length - 1] || null;
        const total = newSegments.reduce((sum, s) => sum + (s.messageCount || 0), 0);
        return {
            ...base,
            segments: newSegments,
            activeSegmentId: activeSeg?.id || '',
            totalCount: total,
            currentCount: activeSeg ? activeSeg.messageCount : 0,
        };
    }

    if (action.type === 'replace') {
        const actMsgs = Array.isArray(action.messages) ? action.messages : [];
        const fps = actMsgs.map(messageFingerprint);
        const prevSegsMsgCount = (segIndex > 0 ? base.segments.slice(0, segIndex) : base.segments).reduce((sum, s) => sum + (s.messageCount || s.messageIds.length), 0);
        const actKeys = nonSystemKeys.slice(prevSegsMsgCount, prevSegsMsgCount + actMsgs.length);
        const updatedSeg = {
            id: action.segmentId,
            documentId: action.documentId,
            status: actMsgs.length >= (targetSeg?.thresholdUsed || 15) ? 'closed' : 'open',
            thresholdUsed: targetSeg?.thresholdUsed || 15,
            messageCount: actMsgs.length,
            messageIds: actKeys,
            fingerprints: fps,
            fingerprint: fps.join(';'),
        };

        const newSegments = [...base.segments];
        if (segIndex >= 0) {
            newSegments[segIndex] = updatedSeg;
        } else {
            newSegments.push(updatedSeg);
        }
        const activeSeg = newSegments[newSegments.length - 1] || null;
        const total = newSegments.reduce((sum, s) => sum + (s.messageCount || 0), 0);
        return {
            ...base,
            segments: newSegments,
            activeSegmentId: activeSeg?.id || '',
            totalCount: total,
            currentCount: activeSeg ? activeSeg.messageCount : 0,
        };
    }

    return base;
}

export function createChatSnapshot({ chatId, bankId, messages = [] }) {
    const nonSystem = (Array.isArray(messages) ? messages : []).filter(m => m && !m.is_system && !m.is_hidden && m.mes !== 'tool_call');
    return {
        chatId: String(chatId || ''),
        bankId: String(bankId || ''),
        messageCount: nonSystem.length,
        fingerprint: segmentFingerprint(nonSystem),
    };
}

export function isSnapshotCurrent(snapshot, current) {
    if (!snapshot || !current) return false;
    return snapshot.chatId === current.chatId &&
        snapshot.bankId === current.bankId &&
        snapshot.messageCount === current.messageCount &&
        snapshot.fingerprint === current.fingerprint;
}

export function canSaveMetadata(expectedSnapshot, currentSnapshot) {
    return !expectedSnapshot || isSnapshotCurrent(expectedSnapshot, currentSnapshot);
}

export function computeSegmentPlan({
    messages,
    existingMetadata,
    chatId,
    bankId,
    bankLabel,
    mode,
    identity,
    messagesPerDocument = 15,
    idGenerator = generateSegmentId,
}) {
    const defaultThreshold = Math.max(1, Number(messagesPerDocument) || 15);
    const resolvedChatId = chatId || existingMetadata?.chatId || 'chat';
    const safeChatId = sanitizeBankId(resolvedChatId, 'chat');
    const nonSystem = (Array.isArray(messages) ? messages : []).filter(m => m && !m.is_system && !m.is_hidden && m.mes !== 'tool_call');

    const resolvedBankId = bankId || existingMetadata?.bankId || `st-chat-${safeChatId}`;
    const resolvedMode = mode || existingMetadata?.mode || 'auto';

    const safeMeta = isMetadataCompatible(existingMetadata, { bankId: resolvedBankId, mode: resolvedMode, chatId: resolvedChatId })
        ? normalizeMetadata(existingMetadata)
        : null;

    const oldSegments = safeMeta?.segments || [];
    const newSegments = [];
    const actions = [];

    let curIdx = 0;

    // 1. Process existing segments using conservative immutable boundaries and creation-time thresholds
    for (let i = 0; i < oldSegments.length && curIdx < nonSystem.length; i++) {
        const oldSeg = oldSegments[i];
        const segThreshold = Number(oldSeg.thresholdUsed) || defaultThreshold;
        const nextOldSeg = oldSegments[i + 1];
        let nextStart = -1;

        const nextKeySet = nextOldSeg && Array.isArray(nextOldSeg.messageIds) ? new Set(nextOldSeg.messageIds) : null;
        const nonSystemKeys = messageKeys(nonSystem);
        if (nextKeySet && nextKeySet.size > 0) {
            for (let j = curIdx; j < nonSystem.length; j++) {
                if (nextKeySet.has(nonSystemKeys[j])) {
                    nextStart = j;
                    break;
                }
            }
        }

        let sliceEnd;
        if (nextStart !== -1) {
            sliceEnd = nextStart;
        } else if (oldSeg.status === 'open' && !nextOldSeg) {
            sliceEnd = Math.min(nonSystem.length, curIdx + segThreshold);
        } else {
            const span = oldSeg.messageCount || segThreshold;
            sliceEnd = Math.min(nonSystem.length, curIdx + span);
        }

        const group = nonSystem.slice(curIdx, sliceEnd);
        const groupStart = curIdx;
        curIdx = sliceEnd;

        if (!group.length) continue;

        const msgKeys = nonSystemKeys.slice(groupStart, groupStart + group.length);
        const fps = group.map(messageFingerprint);
        const currentFp = fps.join(';');
        const segId = oldSeg.id;
        const docId = oldSeg.documentId || `st-chat:${safeChatId}:segment:${segId}`;
        const isLast = (i === oldSegments.length - 1) && (curIdx >= nonSystem.length);
        const isClosed = oldSeg.status === 'open' ? !isLast : (group.length >= segThreshold || !isLast);
        const status = isClosed ? 'closed' : 'open';

        if (currentFp !== oldSeg.fingerprint || status !== oldSeg.status) {
            const wasOpen = oldSeg.status === 'open';
            const isLonger = group.length > (oldSeg.messageCount || 0);
            const prefixMatched = oldSeg.fingerprint && currentFp.startsWith(oldSeg.fingerprint);

            // The open segment is a local buffer. Do not send its incremental
            // changes while it is still the last segment in the conversation.
            if (isLast && !isClosed) {
                // Metadata below keeps the current buffer available locally.
            } else if (wasOpen && isLonger && prefixMatched && status === 'open') {
                actions.push({
                    type: 'append',
                    segmentId: segId,
                    documentId: docId,
                    messages: group.slice(oldSeg.messageCount),
                    segmentMetadata: {
                        id: segId,
                        documentId: docId,
                        status,
                        thresholdUsed: segThreshold,
                        messageCount: group.length,
                        messageIds: msgKeys,
                        fingerprints: fps,
                        fingerprint: currentFp,
                    },
                });
            } else {
                actions.push({
                    type: 'replace',
                    segmentId: segId,
                    documentId: docId,
                    messages: group,
                    segmentMetadata: {
                        id: segId,
                        documentId: docId,
                        status,
                        thresholdUsed: segThreshold,
                        messageCount: group.length,
                        messageIds: msgKeys,
                        fingerprints: fps,
                        fingerprint: currentFp,
                    },
                });
            }
        }

        newSegments.push({
            id: segId,
            documentId: docId,
            status,
            thresholdUsed: segThreshold,
            messageCount: group.length,
            messageIds: msgKeys,
            fingerprints: fps,
            fingerprint: currentFp,
        });
    }

    // 2. Any remaining messages beyond existing segment boundaries create new segments (using current threshold)
    if (curIdx < nonSystem.length) {
        const remaining = nonSystem.slice(curIdx);
        const partitioned = partitionMessages(remaining, defaultThreshold);
        const nonSystemKeys = messageKeys(nonSystem);

        partitioned.forEach((group, idx) => {
            const isLast = (idx === partitioned.length - 1);
            // A full block remains buffered until the conversation advances
            // into the next block. This prevents append/consolidate spam on
            // the block the user is still reviewing or editing.
            const status = isLast ? 'open' : 'closed';
            const groupStart = curIdx;
            const msgKeys = nonSystemKeys.slice(groupStart, groupStart + group.length);
            curIdx += group.length;
            const fps = group.map(messageFingerprint);
            const currentFp = fps.join(';');
            const anchorKey = msgKeys[0] || `idx_${newSegments.length}`;
            const segId = typeof idGenerator === 'function' ? idGenerator(resolvedChatId, anchorKey, newSegments.length) : generateSegmentId(resolvedChatId, anchorKey, newSegments.length);
            const docId = `st-chat:${safeChatId}:segment:${segId}`;

            if (status === 'closed') {
                actions.push({
                    type: 'replace',
                    segmentId: segId,
                    documentId: docId,
                    messages: group,
                    segmentMetadata: {
                        id: segId,
                        documentId: docId,
                        status,
                        thresholdUsed: defaultThreshold,
                        messageCount: group.length,
                        messageIds: msgKeys,
                        fingerprints: fps,
                        fingerprint: currentFp,
                    },
                });
            }

            newSegments.push({
                id: segId,
                documentId: docId,
                status,
                thresholdUsed: defaultThreshold,
                messageCount: group.length,
                messageIds: msgKeys,
                fingerprints: fps,
                fingerprint: currentFp,
            });
        });
    }

    // 3. Managed Document Deletion: delete old automatic documents no longer represented in newSegments
    const newDocIdSet = new Set(newSegments.map(s => s.documentId));
    for (const oldSeg of oldSegments) {
        if (oldSeg.documentId && isValidGeneratedDocumentId(oldSeg.documentId, resolvedChatId) && !newDocIdSet.has(oldSeg.documentId)) {
            actions.push({
                type: 'delete',
                segmentId: oldSeg.id,
                documentId: oldSeg.documentId,
            });
        }
    }

    const activeSegment = newSegments[newSegments.length - 1];
    const totalCount = nonSystem.length;
    const currentCount = activeSegment ? activeSegment.messageCount : 0;

    const metadata = {
        version: 1,
        chatId: resolvedChatId,
        bankId: resolvedBankId,
        bankLabel: bankLabel || (safeMeta?.bankLabel || ''),
        mode: resolvedMode,
        identity: identity || (safeMeta?.identity || { kind: 'chat', value: resolvedChatId }),
        activeSegmentId: activeSegment?.id || '',
        totalCount,
        currentCount,
        segments: newSegments,
    };

    return {
        segments: newSegments,
        metadata,
        actions,
    };
}

export function deterministicOperationId(rawString) {
    const raw = String(rawString || '');
    let h1 = 0x811c9dc5, h2 = 0x27d4eb2f, h3 = 0x165667b1, h4 = 0xdc511234;
    for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 0x01000193);
        h2 = Math.imul(h2 ^ code, 0x01000197);
        h3 = Math.imul(h3 ^ code, 0x010001a3);
        h4 = Math.imul(h4 ^ code, 0x010001b3);
    }
    const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
    const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
    const hex3 = (h3 >>> 0).toString(16).padStart(8, '0');
    const hex4 = (h4 >>> 0).toString(16).padStart(8, '0');
    // Format into standard UUID v5/deterministic shape: 8-4-4-4-12 hex chars
    const p1 = hex1;
    const p2 = hex2.slice(0, 4);
    const p3 = `5${hex2.slice(5, 8)}`; // version 5 (name-based)
    const varNibble = (parseInt(hex3[0], 16) & 0x3 | 0x8).toString(16); // RFC4122 variant
    const p4 = `${varNibble}${hex3.slice(1, 4)}`;
    const p5 = `${hex3.slice(4, 8)}${hex4}`;
    return `${p1}-${p2}-${p3}-${p4}-${p5}`.toLowerCase();
}

export function buildRetainPayload({ messages, documentId, updateMode, chatId, bankId, tags = [] }) {
    const content = conversationTextForMessages(messages);
    const fp = segmentFingerprint(messages);
    const opSeed = `${bankId || ''}:${chatId || ''}:${documentId || ''}:${updateMode || ''}:${fp}:${content.length}`;
    const operation_id = deterministicOperationId(opSeed);
    return {
        items: [{
            content,
            document_id: documentId,
            update_mode: updateMode,
            context: 'SillyTavern roleplay/chat conversation',
            metadata: { source: 'sillytavern-hindsight-extension', chat_id: String(chatId || '') },
            tags,
        }],
        operation_id,
        async: true,
    };
}

export function buildExplicitRetainPayload({ content, context, tags = [] }) {
    return {
        items: [{
            content: String(content || ''),
            context: context || 'explicit model memory',
            tags,
        }],
        async: true,
    };
}

export function buildRecallPayload({ query, budget = 'mid', maxTokens = 2200, tags = [] }) {
    const payload = {
        query: String(query || ''),
        budget,
        max_tokens: Number(maxTokens) || 2200,
        types: ['observation', 'world', 'experience'],
        prefer_observations: true,
    };
    if (tags.length) {
        payload.tags = tags;
        payload.tags_match = 'any_strict';
    }
    return payload;
}

export function buildReflectPayload({ query, budget = 'mid', maxTokens = 2200, tags = [] }) {
    const payload = {
        query: String(query || ''),
        budget,
        max_tokens: Number(maxTokens) || 2200,
    };
    if (tags.length) {
        payload.tags = tags;
        payload.tags_match = 'any_strict';
    }
    return payload;
}

export function formatUiStatus({ bankLabel, mode, segmentCount, currentSegmentIndex, currentSegmentMessages, messagesPerDocument, totalIndexedMessages }) {
    const label = bankLabel || 'unknown';
    const m = mode || 'auto';
    const totalDocs = Math.max(0, segmentCount || 0);
    const currIdx = totalDocs > 0 ? (currentSegmentIndex || totalDocs) : 0;
    const currMsgs = Math.max(0, currentSegmentMessages || 0);
    const threshold = Math.max(1, messagesPerDocument || 15);
    const totalMsgs = Math.max(0, totalIndexedMessages || 0);

    return {
        activeBankText: `Active bank: ${label} [${m}]`,
        docCountText: `Automatic documents: ${totalDocs}`,
        currentDocText: totalDocs > 0 ? `Current document: ${currIdx}/${totalDocs} (${currMsgs}/${threshold} msgs)` : 'Current document: none',
        totalIndexedText: `Indexed total: ${totalMsgs} messages`,
    };
}
