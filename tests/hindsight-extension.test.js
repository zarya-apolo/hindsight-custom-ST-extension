import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sanitizeBankId,
    resolveBankIdentity,
    formatBankLabel,
    parseBanksResponse,
    partitionMessages,
    messageFingerprint,
    segmentFingerprint,
    computeSegmentPlan,
    messageText,
    conversationTextForMessages,
    formatRecall,
    queryTextForMessages,
    buildRetainPayload,
    buildExplicitRetainPayload,
    buildRecallPayload,
    buildReflectPayload,
    buildModelEndpoints,
    formatUiStatus,
    isMetadataCompatible,
    normalizeMetadata,
    deriveChatLabel,
    createChatSnapshot,
    isSnapshotCurrent,
    canSaveMetadata,
    getReadiness,
    messageKeys,
    resolveCurrentCharacter,
    resolveNetworkActionTarget,
    acknowledgeSegmentAction,
} from '../core.js';

test('Identity & Bank Routing: Auto mode produces stable bank per chat', () => {
    const res1 = resolveBankIdentity({
        bankMode: 'auto',
        chatId: 'chat_abc_123',
        chatName: 'Adventure in Tavern',
        character: { avatar: 'pepito.png', name: 'Pepito' },
    });
    const res2 = resolveBankIdentity({
        bankMode: 'auto',
        chatId: 'chat_abc_123',
        chatName: 'Adventure in Tavern Edited',
        character: { avatar: 'other.png', name: 'Other' },
    });
    const resDifferent = resolveBankIdentity({
        bankMode: 'auto',
        chatId: 'chat_xyz_999',
        chatName: 'Another Story',
    });

    assert.equal(res1.bankId, 'st-chat-chat_abc_123');
    assert.equal(res2.bankId, 'st-chat-chat_abc_123');
    assert.notEqual(res1.bankId, resDifferent.bankId);
    assert.equal(res1.mode, 'auto');
    assert.equal(res1.bankLabel, 'Adventure in Tavern (chat_abc_123)');
});

test('Identity & Bank Routing: Character mode uses exact card name as bank ID', () => {
    const card1 = resolveBankIdentity({
        bankMode: 'character',
        chatId: 'chat_1',
        character: { avatar: 'Pepito_card.png', name: 'Pepito' },
    });
    const card1Copy = resolveBankIdentity({
        bankMode: 'character',
        chatId: 'chat_1',
        character: { avatar: 'Pepito_copy.png', name: 'Pepito (1)' },
    });
    const cardNoName = resolveBankIdentity({
        bankMode: 'character',
        chatId: 'chat_abc',
        character: null,
    });

    assert.equal(card1.bankId, 'Pepito');
    assert.equal(card1.bankLabel, 'Pepito');
    assert.equal(card1Copy.bankId, 'Pepito (1)');
    assert.equal(card1Copy.bankLabel, 'Pepito (1)');
    assert.notEqual(card1.bankId, card1Copy.bankId);
    // Group / no character falls safe to per-chat auto identity
    assert.equal(cardNoName.mode, 'auto');
    assert.equal(cardNoName.bankId, 'st-chat-chat_abc');
});

test('Identity & Bank Routing: Custom mode uses exact chosen bank without corrupting URL', () => {
    const custom = resolveBankIdentity({
        bankMode: 'custom',
        customBankId: 'sillytavern/v1:special',
    });
    assert.equal(custom.bankId, 'sillytavern/v1:special');
    assert.equal(custom.mode, 'custom');
    assert.equal(custom.bankLabel, 'sillytavern/v1:special');

    const endpoints = buildModelEndpoints(custom.bankId);
    assert.equal(endpoints.model, '/v1/default/banks/sillytavern%2Fv1%3Aspecial/llm-model');
    assert.equal(endpoints.reflectModel, '/v1/default/banks/sillytavern%2Fv1%3Aspecial/reflect-llm-model');
    assert.equal(endpoints.provider, '/v1/default/banks/sillytavern%2Fv1%3Aspecial/llm-provider');
    assert.equal(endpoints.document('st-chat:chat1:segment:1'), '/v1/default/banks/sillytavern%2Fv1%3Aspecial/documents/st-chat%3Achat1%3Asegment%3A1');
});

test('Parse banks list response robustly', () => {
    assert.deepEqual(parseBanksResponse({ banks: [{ bank_id: 'b1' }, { id: 'b2' }, 'b3'] }), ['b1', 'b2', 'b3']);
    assert.deepEqual(parseBanksResponse([{ bank_id: 'alpha' }, { name: 'beta' }]), ['alpha', 'beta']);
    assert.deepEqual(parseBanksResponse(['one', 'two']), ['one', 'two']);
    assert.deepEqual(parseBanksResponse(null), []);
    assert.deepEqual(parseBanksResponse({}), []);
});

test('Segmentation: partitionMessages respects non-system messages and threshold', () => {
    const msgs = Array.from({ length: 32 }, (_, i) => ({
        mesId: i,
        is_system: i === 0 || i === 10,
        is_user: i % 2 === 1,
        mes: `Message ${i}`,
    }));
    const parts = partitionMessages(msgs, 15);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].length, 15);
    assert.equal(parts[1].length, 15);
});

test('Segmentation & Retention: computeSegmentPlan handles initial, append, and mutation isolation with stable IDs', () => {
    let idSeq = 1;
    const testIdGen = () => `test-seg-${idSeq++}`;
    const makeMsg = (id, text) => ({ mesId: id, is_user: true, mes: text });
    const msgs15 = Array.from({ length: 15 }, (_, i) => makeMsg(`m${i}`, `Text ${i}`));
    
    // 1. Initial 15 messages -> 1 closed segment, replace mode
    const plan1 = computeSegmentPlan({
        messages: msgs15,
        existingMetadata: null,
        chatId: 'chat_1',
        bankId: 'st-chat-chat_1',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: testIdGen,
    });
    assert.equal(plan1.segments.length, 1);
    assert.equal(plan1.segments[0].id, 'test-seg-1');
    assert.equal(plan1.segments[0].status, 'closed');
    assert.equal(plan1.actions.length, 1);
    assert.equal(plan1.actions[0].type, 'replace');
    assert.equal(plan1.actions[0].segmentId, 'test-seg-1');
    assert.equal(plan1.actions[0].documentId, 'st-chat:chat_1:segment:test-seg-1');
    assert.equal(plan1.actions[0].messages.length, 15);

    // 2. Add 16th message -> creates 2nd segment (open, 1 msg), replace mode for new segment
    const msgs16 = [...msgs15, makeMsg('m15', 'Text 15')];
    const plan2 = computeSegmentPlan({
        messages: msgs16,
        existingMetadata: plan1.metadata,
        chatId: 'chat_1',
        bankId: 'st-chat-chat_1',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: testIdGen,
    });
    assert.equal(plan2.segments.length, 2);
    assert.equal(plan2.segments[0].id, 'test-seg-1');
    assert.equal(plan2.segments[0].status, 'closed');
    assert.equal(plan2.segments[1].id, 'test-seg-2');
    assert.equal(plan2.segments[1].status, 'open');
    assert.equal(plan2.actions.length, 1);
    assert.equal(plan2.actions[0].type, 'replace');
    assert.equal(plan2.actions[0].segmentId, 'test-seg-2');
    assert.equal(plan2.actions[0].documentId, 'st-chat:chat_1:segment:test-seg-2');
    assert.equal(plan2.actions[0].messages.length, 1);

    // 3. Add 17th message linearly -> appends only new message to open 2nd segment
    const msgs17 = [...msgs16, makeMsg('m16', 'Text 16')];
    const plan3 = computeSegmentPlan({
        messages: msgs17,
        existingMetadata: plan2.metadata,
        chatId: 'chat_1',
        bankId: 'st-chat-chat_1',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: testIdGen,
    });
    assert.equal(plan3.segments.length, 2);
    assert.equal(plan3.segments[0].id, 'test-seg-1');
    assert.equal(plan3.segments[1].id, 'test-seg-2');
    assert.equal(plan3.actions.length, 1);
    assert.equal(plan3.actions[0].type, 'append');
    assert.equal(plan3.actions[0].segmentId, 'test-seg-2');
    assert.equal(plan3.actions[0].documentId, 'st-chat:chat_1:segment:test-seg-2');
    assert.equal(plan3.actions[0].messages.length, 1);
    assert.equal(plan3.actions[0].messages[0].mesId, 'm16');

    // 4. Mutation in segment 1 (e.g. edit message m2) -> only segment 1 is replaced, segment 2 is untouched
    const msgs17Edited = msgs17.map(m => m.mesId === 'm2' ? { ...m, mes: 'Edited text 2' } : m);
    const plan4 = computeSegmentPlan({
        messages: msgs17Edited,
        existingMetadata: plan3.metadata,
        chatId: 'chat_1',
        bankId: 'st-chat-chat_1',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: testIdGen,
    });
    assert.equal(plan4.segments.length, 2);
    assert.equal(plan4.segments[0].id, 'test-seg-1');
    assert.equal(plan4.segments[1].id, 'test-seg-2');
    assert.equal(plan4.actions.length, 1);
    assert.equal(plan4.actions[0].type, 'replace');
    assert.equal(plan4.actions[0].segmentId, 'test-seg-1');
    assert.equal(plan4.actions[0].documentId, 'st-chat:chat_1:segment:test-seg-1');
    assert.equal(plan4.actions[0].messages.length, 15);
});

test('Stable segment IDs: message deletion in segment 1 does not rename segment 2 or change its document ID', () => {
    let idSeq = 1;
    const testIdGen = () => `seg-uuid-${idSeq++}`;
    const makeMsg = (id, text) => ({ mesId: id, is_user: true, mes: text });
    
    // 30 messages -> 2 closed segments of 15 each
    const msgs30 = Array.from({ length: 30 }, (_, i) => makeMsg(`m${i}`, `Text ${i}`));
    const plan1 = computeSegmentPlan({
        messages: msgs30,
        existingMetadata: null,
        chatId: 'chat_alpha',
        bankId: 'st-chat-chat_alpha',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: testIdGen,
    });
    assert.equal(plan1.segments.length, 2);
    const seg1Id = plan1.segments[0].id;
    const seg2Id = plan1.segments[1].id;
    const seg2DocId = plan1.segments[1].documentId;
    assert.equal(seg1Id, 'seg-uuid-1');
    assert.equal(seg2Id, 'seg-uuid-2');

    // Delete message m2 from segment 1 (now 29 messages: m0..m1, m3..m29)
    const msgs29 = msgs30.filter(m => m.mesId !== 'm2');
    const plan2 = computeSegmentPlan({
        messages: msgs29,
        existingMetadata: plan1.metadata,
        chatId: 'chat_alpha',
        bankId: 'st-chat-chat_alpha',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: testIdGen,
    });

    assert.equal(plan2.segments.length, 2);
    // Segment 1 kept its ID and was replaced
    assert.equal(plan2.segments[0].id, seg1Id);
    // Segment 2 MUST keep its ID and MUST NOT be renamed or shifted
    assert.equal(plan2.segments[1].id, seg2Id);
    assert.equal(plan2.segments[1].documentId, seg2DocId);
    // Only segment 1 needs replacement, segment 2 is completely unchanged
    assert.equal(plan2.actions.length, 1);
    assert.equal(plan2.actions[0].type, 'replace');
    assert.equal(plan2.actions[0].segmentId, seg1Id);
});

test('Stable segment IDs: inserting content does not reuse positional IDs', () => {
    let idSeq = 1;
    const testIdGen = () => `uuid-${idSeq++}`;
    const makeMsg = (id, text) => ({ mesId: id, is_user: true, mes: text });

    const msgs15 = Array.from({ length: 15 }, (_, i) => makeMsg(`m${i}`, `Text ${i}`));
    const plan1 = computeSegmentPlan({
        messages: msgs15,
        existingMetadata: null,
        chatId: 'chat_beta',
        bankId: 'st-chat-chat_beta',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: testIdGen,
    });
    assert.equal(plan1.segments[0].id, 'uuid-1');

    // Add 16th message -> creates new segment with uuid-2
    const msgs16 = [...msgs15, makeMsg('m15', 'Text 15')];
    const plan2 = computeSegmentPlan({
        messages: msgs16,
        existingMetadata: plan1.metadata,
        chatId: 'chat_beta',
        bankId: 'st-chat-chat_beta',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: testIdGen,
    });
    assert.equal(plan2.segments[1].id, 'uuid-2');
});

test('Metadata compatibility: rejects metadata from different bankId, mode, or chatId', () => {
    const meta = {
        version: 1,
        chatId: 'chat_1',
        bankId: 'st-chat-chat_1',
        mode: 'auto',
        bankLabel: 'Chat (chat_1)',
        identity: { kind: 'chat', value: 'chat_1' },
        segments: [{ id: 'seg-1', documentId: 'st-chat:chat_1:segment:seg-1', messageIds: ['m0'], fingerprints: ['fp0'], fingerprint: 'fp0', messageCount: 1, status: 'open', thresholdUsed: 15 }],
        currentCount: 1,
        totalCount: 1,
        activeSegmentId: 'seg-1',
    };

    assert.equal(isMetadataCompatible(meta, { bankId: 'st-chat-chat_1', mode: 'auto', chatId: 'chat_1' }), true);
    // Different bankId
    assert.equal(isMetadataCompatible(meta, { bankId: 'st-char-pepito', mode: 'character', chatId: 'chat_1' }), false);
    // Different mode
    assert.equal(isMetadataCompatible(meta, { bankId: 'st-chat-chat_1', mode: 'custom', chatId: 'chat_1' }), false);
    // Different chatId
    assert.equal(isMetadataCompatible(meta, { bankId: 'st-chat-chat_2', mode: 'auto', chatId: 'chat_2' }), false);
    // Missing / null
    assert.equal(isMetadataCompatible(null, { bankId: 'st-chat-chat_1' }), false);
});

test('Metadata contract: computeSegmentPlan outputs full required metadata fields', () => {
    const makeMsg = (id, text) => ({ mesId: id, is_user: true, mes: text });
    const msgs = Array.from({ length: 18 }, (_, i) => makeMsg(`m${i}`, `Message ${i}`));

    const plan = computeSegmentPlan({
        messages: msgs,
        existingMetadata: null,
        chatId: 'chat_meta',
        bankId: 'st-chat-chat_meta',
        bankLabel: 'Test Chat (chat_meta)',
        mode: 'auto',
        identity: { kind: 'chat', value: 'chat_meta' },
        messagesPerDocument: 15,
        idGenerator: () => 'stable-id',
    });

    const meta = plan.metadata;
    assert.equal(meta.version, 1);
    assert.equal(meta.chatId, 'chat_meta');
    assert.equal(meta.bankId, 'st-chat-chat_meta');
    assert.equal(meta.bankLabel, 'Test Chat (chat_meta)');
    assert.equal(meta.mode, 'auto');
    assert.deepEqual(meta.identity, { kind: 'chat', value: 'chat_meta' });
    assert.equal(meta.totalCount, 18);
    assert.equal(meta.currentCount, 3);
    assert.equal(meta.segments.length, 2);

    const seg0 = meta.segments[0];
    assert.equal(seg0.status, 'closed');
    assert.equal(seg0.thresholdUsed, 15);
    assert.equal(seg0.messageCount, 15);
    assert.equal(Array.isArray(seg0.messageIds), true);
    assert.equal(Array.isArray(seg0.fingerprints), true);
    assert.equal(typeof seg0.fingerprint, 'string');

    const seg1 = meta.segments[1];
    assert.equal(seg1.status, 'open');
    assert.equal(seg1.thresholdUsed, 15);
    assert.equal(seg1.messageCount, 3);

    // normalizeMetadata helper
    const normalized = normalizeMetadata(meta);
    assert.equal(normalized.chatId, 'chat_meta');
    assert.equal(normalized.segments.length, 2);
});

test('Chat label derivation: resolves gracefully without context.chatName', () => {
    // 1. From getCurrentChatDetails
    const label1 = deriveChatLabel({
        chatDetails: { name: 'My Tavern Story' },
        chatMetadata: { chat_name: 'Meta Story' },
        context: { chatId: 'chat_123' },
    });
    assert.equal(label1, 'My Tavern Story');

    // 2. From chatMetadata fallback
    const label2 = deriveChatLabel({
        chatDetails: null,
        chatMetadata: { chat_name: 'Meta Story' },
        context: { chatId: 'chat_123' },
    });
    assert.equal(label2, 'Meta Story');

    // 3. From context chatId fallback (no context.chatName)
    const label3 = deriveChatLabel({
        chatDetails: null,
        chatMetadata: null,
        context: { chatId: 'chat_456' },
        chatId: 'chat_456',
    });
    assert.equal(label3, 'chat_456');

    // 4. Default fallback
    const label4 = deriveChatLabel({});
    assert.equal(label4, 'Chat');
});

test('Chat-switch / async race: snapshot captures and detects mutations or switches', () => {
    const msgs = [{ mesId: '1', is_user: true, mes: 'Hello' }];
    const snap1 = createChatSnapshot({
        chatId: 'chat_1',
        bankId: 'st-chat-chat_1',
        messages: msgs,
    });

    assert.equal(isSnapshotCurrent(snap1, {
        chatId: 'chat_1',
        bankId: 'st-chat-chat_1',
        messageCount: 1,
        fingerprint: segmentFingerprint(msgs),
    }), true);

    // Chat switched
    assert.equal(isSnapshotCurrent(snap1, {
        chatId: 'chat_2',
        bankId: 'st-chat-chat_1',
        messageCount: 1,
        fingerprint: segmentFingerprint(msgs),
    }), false);

    // Bank switched
    assert.equal(isSnapshotCurrent(snap1, {
        chatId: 'chat_1',
        bankId: 'st-char-pepito',
        messageCount: 1,
        fingerprint: segmentFingerprint(msgs),
    }), false);

    // Message added
    assert.equal(isSnapshotCurrent(snap1, {
        chatId: 'chat_1',
        bankId: 'st-chat-chat_1',
        messageCount: 2,
        fingerprint: 'other_fp',
    }), false);
});

test('Metadata save guard rejects stale snapshots and allows the unchanged chat', () => {
    const snapshot = createChatSnapshot({
        chatId: 'chat_guard',
        bankId: 'st-chat-chat_guard',
        messages: [{ mesId: 'm1', is_user: true, mes: 'unchanged' }],
    });
    assert.equal(canSaveMetadata(snapshot, snapshot), true);
    assert.equal(canSaveMetadata(snapshot, { ...snapshot, chatId: 'chat_other' }), false);
    assert.equal(canSaveMetadata(null, snapshot), true);
});

test('Swipe/Regeneration detection via fingerprint', () => {
    const m1 = { mesId: 'm1', is_user: false, mes: 'Option A' };
    const m1Swiped = { mesId: 'm1', is_user: false, mes: 'Option B' };
    assert.notEqual(messageFingerprint(m1), messageFingerprint(m1Swiped));
});

test('No 120000 truncation on conversation text', () => {
    const longString = 'x'.repeat(150000);
    const msg = { mesId: '1', is_user: true, mes: longString };
    const text = conversationTextForMessages([msg]);
    assert.equal(text.length > 120000, true);
    assert.ok(text.includes(longString));
});

test('Explicit retain omits document_id for independent document creation', () => {
    const payload = buildExplicitRetainPayload({
        content: 'User prefers dark roast coffee.',
        context: 'preferences',
    });
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].document_id, undefined);
    assert.equal(payload.items[0].content, 'User prefers dark roast coffee.');
    assert.equal(payload.async, true);
});

test('Recall & Reflect payloads route to correct endpoints and structure', () => {
    const recall = buildRecallPayload({
        query: 'favorite color',
        budget: 'high',
        maxTokens: 1500,
    });
    assert.equal(recall.query, 'favorite color');
    assert.equal(recall.budget, 'high');
    assert.equal(recall.max_tokens, 1500);
    assert.deepEqual(recall.types, ['observation', 'world', 'experience']);

    const reflect = buildReflectPayload({
        query: 'synthesize timeline',
        budget: 'mid',
        maxTokens: 2000,
    });
    assert.equal(reflect.query, 'synthesize timeline');
    assert.equal(reflect.budget, 'mid');
});

test('UI Status formatting matches contract', () => {
    const statusInfo = formatUiStatus({
        bankLabel: 'Tavern Talk (chat_123)',
        mode: 'auto',
        segmentCount: 3,
        currentSegmentIndex: 3,
        currentSegmentMessages: 8,
        messagesPerDocument: 15,
        totalIndexedMessages: 38,
    });
    assert.equal(statusInfo.activeBankText, 'Active bank: Tavern Talk (chat_123) [auto]');
    assert.equal(statusInfo.docCountText, 'Automatic documents: 3');
    assert.equal(statusInfo.currentDocText, 'Current document: 3/3 (8/15 msgs)');
    assert.equal(statusInfo.totalIndexedText, 'Indexed total: 38 messages');
});

test('Real-ST identity & timestamps: 30 messages without mesId/id preserve segment 2 on segment 1 edit', () => {
    // Real ST messages only have send_date, is_user, mes/content, etc. No mesId or id.
    const realMsgs = Array.from({ length: 30 }, (_, i) => ({
        send_date: `2026-08-30 10:${String(i).padStart(2, '0')}:00`,
        is_user: i % 2 === 0,
        name: i % 2 === 0 ? 'User' : 'Zarya',
        mes: `Dialogue message ${i}`,
    }));

    const plan1 = computeSegmentPlan({
        messages: realMsgs,
        existingMetadata: null,
        chatId: 'chat_real_st',
        bankId: 'st-chat-chat_real_st',
        mode: 'auto',
        messagesPerDocument: 15,
    });

    assert.equal(plan1.segments.length, 2);
    const seg1Id = plan1.segments[0].id;
    const seg2Id = plan1.segments[1].id;
    const seg2DocId = plan1.segments[1].documentId;

    // Mutate segment 1: edit message 2 content (keep its timestamp and role)
    const mutated = realMsgs.map((m, idx) => idx === 2 ? { ...m, mes: 'Edited dialogue 2' } : m);

    const plan2 = computeSegmentPlan({
        messages: mutated,
        existingMetadata: plan1.metadata,
        chatId: 'chat_real_st',
        bankId: 'st-chat-chat_real_st',
        mode: 'auto',
        messagesPerDocument: 15,
    });

    assert.equal(plan2.segments.length, 2);
    assert.equal(plan2.segments[0].id, seg1Id);
    assert.equal(plan2.segments[1].id, seg2Id);
    assert.equal(plan2.segments[1].documentId, seg2DocId);
    // Actions should only replace segment 1
    assert.equal(plan2.actions.length, 1);
    assert.equal(plan2.actions[0].type, 'replace');
    assert.equal(plan2.actions[0].segmentId, seg1Id);
});

test('Managed document deletion: truncate 31 messages to 10 emits delete for segment 2 and 3', () => {
    const msgs = Array.from({ length: 31 }, (_, i) => ({
        send_date: `2026-08-30 11:${String(i).padStart(2, '0')}:00`,
        is_user: true,
        mes: `Msg ${i}`,
    }));

    const planFull = computeSegmentPlan({
        messages: msgs,
        existingMetadata: null,
        chatId: 'chat_trunc',
        bankId: 'st-chat-chat_trunc',
        mode: 'auto',
        messagesPerDocument: 15,
    });
    // 31 messages / 15 threshold = 3 segments (15, 15, 1)
    assert.equal(planFull.segments.length, 3);
    const seg2DocId = planFull.segments[1].documentId;
    const seg3DocId = planFull.segments[2].documentId;

    // Truncate to 10 messages
    const truncated = msgs.slice(0, 10);
    const planTrunc = computeSegmentPlan({
        messages: truncated,
        existingMetadata: planFull.metadata,
        chatId: 'chat_trunc',
        bankId: 'st-chat-chat_trunc',
        mode: 'auto',
        messagesPerDocument: 15,
    });

    assert.equal(planTrunc.segments.length, 1);
    const deleteActions = planTrunc.actions.filter(a => a.type === 'delete');
    assert.equal(deleteActions.length, 2);
    assert.equal(deleteActions.some(a => a.documentId === seg2DocId), true);
    assert.equal(deleteActions.some(a => a.documentId === seg3DocId), true);
});

test('Threshold is creation-time, not retroactive', () => {
    // 8 messages created under threshold 15 -> open segment with thresholdUsed: 15
    const msgs8 = Array.from({ length: 8 }, (_, i) => ({
        send_date: `2026-08-30 12:${String(i).padStart(2, '0')}:00`,
        is_user: true,
        mes: `Msg ${i}`,
    }));

    const plan1 = computeSegmentPlan({
        messages: msgs8,
        existingMetadata: null,
        chatId: 'chat_thresh',
        bankId: 'st-chat-chat_thresh',
        mode: 'auto',
        messagesPerDocument: 15,
    });

    assert.equal(plan1.segments.length, 1);
    assert.equal(plan1.segments[0].thresholdUsed, 15);
    assert.equal(plan1.segments[0].status, 'open');

    // Setting changes to 5, but messages do not change -> no remote actions, thresholdUsed remains 15
    const planNoChange = computeSegmentPlan({
        messages: msgs8,
        existingMetadata: plan1.metadata,
        chatId: 'chat_thresh',
        bankId: 'st-chat-chat_thresh',
        mode: 'auto',
        messagesPerDocument: 5,
    });

    assert.equal(planNoChange.actions.length, 0);
    assert.equal(planNoChange.segments[0].thresholdUsed, 15);
    assert.equal(planNoChange.segments[0].status, 'open');

    // Fill up to 15 messages (still inside segment 1 threshold 15)
    const msgs15 = Array.from({ length: 15 }, (_, i) => ({
        send_date: `2026-08-30 12:${String(i).padStart(2, '0')}:00`,
        is_user: true,
        mes: `Msg ${i}`,
    }));
    const plan15 = computeSegmentPlan({
        messages: msgs15,
        existingMetadata: plan1.metadata,
        chatId: 'chat_thresh',
        bankId: 'st-chat-chat_thresh',
        mode: 'auto',
        messagesPerDocument: 5,
    });
    assert.equal(plan15.segments.length, 1);
    assert.equal(plan15.segments[0].status, 'closed');
    assert.equal(plan15.segments[0].thresholdUsed, 15);

    // 16th message creates segment 2 with the NEW threshold (5)
    const msgs16 = [...msgs15, {
        send_date: '2026-08-30 12:16:00',
        is_user: true,
        mes: 'Msg 15',
    }];
    const plan16 = computeSegmentPlan({
        messages: msgs16,
        existingMetadata: plan15.metadata,
        chatId: 'chat_thresh',
        bankId: 'st-chat-chat_thresh',
        mode: 'auto',
        messagesPerDocument: 5,
    });
    assert.equal(plan16.segments.length, 2);
    assert.equal(plan16.segments[0].thresholdUsed, 15);
    assert.equal(plan16.segments[0].status, 'closed');
    assert.equal(plan16.segments[1].thresholdUsed, 5);
    assert.equal(plan16.segments[1].status, 'open');
});

test('Fail-closed metadata validation: computeSegmentPlan rejects malformed/corrupted metadata and prevents deleting legacy/explicit documents', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({ mesId: `m${i}`, is_user: true, mes: `Hi ${i}` }));
    
    // Malformed segment metadata: missing documentId or invalid generated document ID format, negative counts, array mismatch
    const badMeta = {
        version: 1,
        chatId: 'chat_safe',
        bankId: 'st-chat-chat_safe',
        mode: 'auto',
        segments: [
            {
                id: 'legacy-doc',
                documentId: 'sillytavern-custom-doc-123', // Not a valid generated automatic doc format
                status: 'closed',
                messageCount: 5,
                messageIds: ['m0', 'm1', 'm2', 'm3', 'm4'],
                fingerprints: ['f0', 'f1', 'f2', 'f3', 'f4'],
                fingerprint: 'f0;f1;f2;f3;f4',
            },
        ],
    };

    const plan = computeSegmentPlan({
        messages: msgs,
        existingMetadata: badMeta,
        chatId: 'chat_safe',
        bankId: 'st-chat-chat_safe',
        mode: 'auto',
        messagesPerDocument: 15,
    });

    // Since badMeta has non-generated/legacy documentId format, it must be rejected (fail-closed)
    // No delete action must be emitted for 'sillytavern-custom-doc-123'
    const deleteActions = plan.actions.filter(a => a.type === 'delete');
    assert.equal(deleteActions.length, 0);
    // And new segment should be created with valid generated format st-chat:<chat-id>:segment:<seg-id>
    assert.equal(plan.segments.length, 1);
    assert.match(plan.segments[0].documentId, /^st-chat:chat_safe:segment:.+$/);
});

test('Real ST duplicate timestamps: messageKeys produces deterministic collision-free keys', () => {
    const msgs = [
        { send_date: '2026-08-30 10:00:00', is_user: true, mes: 'First' },
        { send_date: '2026-08-30 10:00:00', is_user: true, mes: 'Duplicate stamp user' },
        { send_date: '2026-08-30 10:00:00', is_user: false, name: 'Assistant', mes: 'Duplicate stamp assistant' },
        { send_date: '2026-08-30 10:00:00', is_user: true, mes: 'Third user with same stamp' },
    ];
    const keys = messageKeys(msgs);
    assert.equal(keys.length, 4);
    const uniqueKeys = new Set(keys);
    assert.equal(uniqueKeys.size, 4);
    assert.equal(keys[0], 'user_2026-08-30 10:00:00#0');
    assert.equal(keys[1], 'user_2026-08-30 10:00:00#1');
    assert.equal(keys[2], 'Assistant_2026-08-30 10:00:00#0');
    assert.equal(keys[3], 'user_2026-08-30 10:00:00#2');
});

test('Group chat & Character resolution: resolveCurrentCharacter returns null in group chats and never invents character name', () => {
    // 1. Group chat (groupId present) -> returns null
    const groupChar = resolveCurrentCharacter({
        context: { groupId: 'group-123', characterName: 'Pepito' },
        this_chid: 0,
        characters: [{ name: 'Pepito' }],
    });
    assert.equal(groupChar, null);

    // 2. Normal chat with card -> returns exact name and avatar
    const normalChar = resolveCurrentCharacter({
        context: { characterId: 1 },
        characters: [null, { name: 'Seraphina', avatar: 'seraphina.png' }],
    });
    assert.deepEqual(normalChar, { name: 'Seraphina', avatar: 'seraphina.png' });

    // 3. Normal chat with no card loaded -> returns null, does not invent 'character'
    const noCard = resolveCurrentCharacter({
        context: {},
        characters: [],
    });
    assert.equal(noCard, null);
});

test('Action descriptors & boundaries: plan actions map delete -> document endpoint, retains -> memories endpoint, never bank DELETE', () => {
    const endpoints = buildModelEndpoints('st-chat-test');
    
    // Test delete action resolution
    const deleteAction = { type: 'delete', segmentId: 'seg_1', documentId: 'st-chat:chat_1:segment:seg_1' };
    const deleteTarget = resolveNetworkActionTarget(endpoints, deleteAction);
    assert.equal(deleteTarget.method, 'DELETE');
    assert.equal(deleteTarget.url, '/v1/default/banks/st-chat-test/documents/st-chat%3Achat_1%3Asegment%3Aseg_1');
    assert.equal(deleteTarget.isBankDelete, false);

    // Test retain/append action resolution
    const retainAction = { type: 'append', segmentId: 'seg_2', documentId: 'st-chat:chat_1:segment:seg_2', messages: [] };
    const retainTarget = resolveNetworkActionTarget(endpoints, retainAction);
    assert.equal(retainTarget.method, 'POST');
    assert.equal(retainTarget.url, '/v1/default/banks/st-chat-test/memories');
});

test('Async append retry duplication: acknowledgeSegmentAction models safe state transition without double-append on subsequent retries', () => {
    const makeMsg = (id, text) => ({ mesId: id, is_user: true, mes: text });
    const msgs15 = Array.from({ length: 15 }, (_, i) => makeMsg(`m${i}`, `Text ${i}`));
    const msgs17 = [...msgs15, makeMsg('m15', 'Text 15'), makeMsg('m16', 'Text 16')];

    // Initial state: segment 1 closed (15 msgs), segment 2 open (1 msg, m15)
    const planInitial = computeSegmentPlan({
        messages: msgs15.concat(makeMsg('m15', 'Text 15')),
        existingMetadata: null,
        chatId: 'chat_ack',
        bankId: 'st-chat-chat_ack',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: (c, k, i) => `seg_${i + 1}`,
    });
    assert.equal(planInitial.segments.length, 2);
    assert.equal(planInitial.segments[1].messageCount, 1);

    // Plan for 17 messages -> emits append for m16 on segment 2
    const planNext = computeSegmentPlan({
        messages: msgs17,
        existingMetadata: planInitial.metadata,
        chatId: 'chat_ack',
        bankId: 'st-chat-chat_ack',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: (c, k, i) => `seg_${i + 1}`,
    });
    assert.equal(planNext.actions.length, 1);
    assert.equal(planNext.actions[0].type, 'append');

    // Acknowledge the append action successfully
    const ackedMeta = acknowledgeSegmentAction(planInitial.metadata, planNext.actions[0], msgs17);
    assert.equal(ackedMeta.segments[1].messageCount, 2);
    assert.deepEqual(ackedMeta.segments[1].messageIds, ['m15', 'm16']);

    // If a subsequent operation fails and triggers retry with the same messages (msgs17),
    // computing the plan on ackedMeta must NOT produce an append action again
    const retryPlan = computeSegmentPlan({
        messages: msgs17,
        existingMetadata: ackedMeta,
        chatId: 'chat_ack',
        bankId: 'st-chat-chat_ack',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: (c, k, i) => `seg_${i + 1}`,
    });
    assert.equal(retryPlan.actions.length, 0);
});

test('Collision safety: distinct raw IDs with special chars do not collide', () => {
    const idA = sanitizeBankId('adventure/part 1');
    const idB = sanitizeBankId('adventure part 1');
    assert.notEqual(idA, idB);

    // Safe simple string remains simple
    assert.equal(sanitizeBankId('chat_123'), 'chat_123');
});

test('Multi-segment initial chat acknowledgement: 31 messages with multiple replace retains correctly maps keys and counters without clobbering', () => {
    const msgs31 = Array.from({ length: 31 }, (_, i) => ({
        send_date: `2026-08-30 10:${String(i).padStart(2, '0')}:00`,
        is_user: i % 2 === 0,
        mes: `Message ${i}`,
    }));

    // Initial plan for 31 messages without prior metadata: 3 segments (15, 15, 1) -> 3 replace actions
    const plan = computeSegmentPlan({
        messages: msgs31,
        existingMetadata: null,
        chatId: 'chat_multi_31',
        bankId: 'st-chat-chat_multi_31',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: (c, k, i) => `seg_${i + 1}`,
    });

    assert.equal(plan.segments.length, 3);
    assert.equal(plan.actions.length, 3);
    assert.equal(plan.actions[0].type, 'replace');
    assert.equal(plan.actions[1].type, 'replace');
    assert.equal(plan.actions[2].type, 'replace');

    // Simulate stepping through retainCurrentChat: rollingMeta starts null (no prior meta)
    let rollingMeta = null;
    for (const act of plan.actions) {
        rollingMeta = acknowledgeSegmentAction(rollingMeta, act, msgs31);
    }

    assert.equal(rollingMeta.segments.length, 3);
    assert.equal(rollingMeta.totalCount, 31);
    assert.equal(rollingMeta.currentCount, 1);
    assert.equal(rollingMeta.activeSegmentId, 'seg_3');

    // Verify each segment has its EXACT corresponding messageIds and fingerprints
    const expectedKeys = messageKeys(msgs31);
    assert.deepEqual(rollingMeta.segments[0].messageIds, expectedKeys.slice(0, 15));
    assert.deepEqual(rollingMeta.segments[1].messageIds, expectedKeys.slice(15, 30));
    assert.deepEqual(rollingMeta.segments[2].messageIds, expectedKeys.slice(30, 31));

    // Verify subsequent growth (32nd message) produces an append ONLY on segment 3
    const msgs32 = [...msgs31, {
        send_date: '2026-08-30 10:32:00',
        is_user: true,
        mes: 'Message 31 (32nd)',
    }];

    const nextPlan = computeSegmentPlan({
        messages: msgs32,
        existingMetadata: rollingMeta,
        chatId: 'chat_multi_31',
        bankId: 'st-chat-chat_multi_31',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: (c, k, i) => `seg_${i + 1}`,
    });

    assert.equal(nextPlan.segments.length, 3);
    assert.equal(nextPlan.actions.length, 1);
    assert.equal(nextPlan.actions[0].type, 'append');
    assert.equal(nextPlan.actions[0].segmentId, 'seg_3');
    assert.equal(nextPlan.actions[0].messages.length, 1);
    assert.equal(nextPlan.actions[0].messages[0].mes, 'Message 31 (32nd)');
});

test('Partial acknowledgement & truncation: acknowledges step-by-step maintaining correct counters and untouched segments', () => {
    const makeMsg = (id, text) => ({ mesId: id, is_user: true, mes: text });
    const msgs30 = Array.from({ length: 30 }, (_, i) => makeMsg(`m${i}`, `Text ${i}`));
    
    // Initial 30 messages (2 segments of 15)
    const plan = computeSegmentPlan({
        messages: msgs30,
        existingMetadata: null,
        chatId: 'chat_part',
        bankId: 'st-chat-chat_part',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: (c, k, i) => `seg_${i + 1}`,
    });

    assert.equal(plan.actions.length, 2);
    // Acknowledge only segment 1
    const metaStep1 = acknowledgeSegmentAction(null, plan.actions[0], msgs30);
    assert.equal(metaStep1.segments.length, 1);
    assert.equal(metaStep1.totalCount, 15);
    assert.equal(metaStep1.currentCount, 15);
    assert.equal(metaStep1.activeSegmentId, 'seg_1');

    // Acknowledge segment 2
    const metaStep2 = acknowledgeSegmentAction(metaStep1, plan.actions[1], msgs30);
    assert.equal(metaStep2.segments.length, 2);
    assert.equal(metaStep2.totalCount, 30);
    assert.equal(metaStep2.currentCount, 15);
    assert.equal(metaStep2.activeSegmentId, 'seg_2');

    // Truncation: chat truncated from 30 to 10 messages -> emits delete for segment 2, replace for segment 1
    const msgs10 = msgs30.slice(0, 10);
    const truncPlan = computeSegmentPlan({
        messages: msgs10,
        existingMetadata: metaStep2,
        chatId: 'chat_part',
        bankId: 'st-chat-chat_part',
        mode: 'auto',
        messagesPerDocument: 15,
        idGenerator: (c, k, i) => `seg_${i + 1}`,
    });

    assert.equal(truncPlan.actions.length, 2);
    const delAction = truncPlan.actions.find(a => a.type === 'delete');
    const replAction = truncPlan.actions.find(a => a.type === 'replace');
    assert.ok(delAction);
    assert.ok(replAction);

    // If only delete finishes first
    const metaAfterDel = acknowledgeSegmentAction(metaStep2, delAction, msgs10);
    assert.equal(metaAfterDel.segments.length, 1);
    assert.equal(metaAfterDel.segments[0].id, 'seg_1');
    assert.equal(metaAfterDel.totalCount, 15); // seg 1 has not been updated yet
    assert.equal(metaAfterDel.activeSegmentId, 'seg_1');

    // Then replace finishes
    const metaAfterRepl = acknowledgeSegmentAction(metaAfterDel, replAction, msgs10);
    assert.equal(metaAfterRepl.segments.length, 1);
    assert.equal(metaAfterRepl.segments[0].id, 'seg_1');
    assert.equal(metaAfterRepl.totalCount, 10);
    assert.equal(metaAfterRepl.currentCount, 10);
});

test('Idempotent operation_id: deterministic UUID per automatic retain action, omitted in explicit retain', () => {
    const makeMsg = (id, text) => ({ mesId: id, is_user: true, mes: text });
    const msgs = [makeMsg('m1', 'Hello memory')];

    // Automatic retain payload includes deterministic UUID operation_id
    const payload1 = buildRetainPayload({
        messages: msgs,
        documentId: 'st-chat:chat_1:segment:seg_1',
        updateMode: 'replace',
        chatId: 'chat_1',
        bankId: 'st-chat-chat_1',
    });

    assert.ok(payload1.operation_id, 'Automatic retain must include operation_id');
    // UUID v4/v5 format check: 8-4-4-4-12 hex chars
    assert.match(payload1.operation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    // Repeating for same content/action produces identical operation_id (stable retry)
    const payload1Retry = buildRetainPayload({
        messages: msgs,
        documentId: 'st-chat:chat_1:segment:seg_1',
        updateMode: 'replace',
        chatId: 'chat_1',
        bankId: 'st-chat-chat_1',
    });
    assert.equal(payload1.operation_id, payload1Retry.operation_id);

    // Different content produces DIFFERENT operation_id
    const payloadDiff = buildRetainPayload({
        messages: [makeMsg('m1', 'Different text')],
        documentId: 'st-chat:chat_1:segment:seg_1',
        updateMode: 'replace',
        chatId: 'chat_1',
        bankId: 'st-chat-chat_1',
    });
    assert.notEqual(payload1.operation_id, payloadDiff.operation_id);

    // Different update_mode produces DIFFERENT operation_id
    const payloadAppend = buildRetainPayload({
        messages: msgs,
        documentId: 'st-chat:chat_1:segment:seg_1',
        updateMode: 'append',
        chatId: 'chat_1',
        bankId: 'st-chat-chat_1',
    });
    assert.notEqual(payload1.operation_id, payloadAppend.operation_id);

    // Explicit retain MUST NOT have operation_id or document_id
    const explicitPayload = buildExplicitRetainPayload({
        content: 'Explicit fact',
        context: 'preferences',
    });
    assert.equal(explicitPayload.operation_id, undefined);
    assert.equal(explicitPayload.items[0].document_id, undefined);
});

test('Readiness separation: Hindsight memory and provider are independent', () => {
    // 1. Only Hindsight URL configured
    const r1 = getReadiness({
        enabled: false,
        hindsightUrl: 'http://localhost:8888',
        providerUrl: '',
        providerApiKey: '',
    });
    assert.equal(r1.isBackendReachable, true);
    assert.equal(r1.isMemoryReady, false);
    assert.equal(r1.isProviderReady, false);

    // 2. Enabled + Hindsight URL -> Memory ready even without provider
    const r2 = getReadiness({
        enabled: true,
        hindsightUrl: 'http://localhost:8888',
        providerUrl: '',
        providerApiKey: '',
    });
    assert.equal(r2.isMemoryReady, true);
    assert.equal(r2.isProviderReady, false);

    // 3. Provider ready requires URL and Key
    const r3 = getReadiness({
        enabled: true,
        hindsightUrl: 'http://localhost:8888',
        providerUrl: 'https://openrouter.ai/api/v1',
        providerApiKey: 'sk-or-123',
    });
    assert.equal(r3.isFullyConfigured, true);
});
