import {
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateQuietPrompt,
    itemizedParams,
    itemizedPrompts,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { debounce } from '../../../utils.js';
import { getWorldInfoPrompt } from '../../../world-info.js';
import { getRegexedString, regex_placement } from '../../regex/engine.js';

const MODULE_NAME = 'st-screenwriter';
const PANEL_ID = 'st-screenwriter-settings';
const STATE_KEY = MODULE_NAME;
const CHECKPOINT_SUMMARIZE_METADATA_KEY = 'checkpoint_summarize';
const STCS_HIDDEN_BLOCK_MARKER = '<!--STCS_START-->';
const AUTO_RECENT_CHAT_SAFETY_BUFFER_TOKENS = 2000;
const DEFAULT_CHECKPOINT_INJECTION_TEMPLATE = `[Checkpoint Memory]

The following are manually reviewed checkpoint summaries of earlier chat history.
Treat them as established continuity/canon unless contradicted by more recent raw messages.

{{checkpoint_blocks}}

[End Checkpoint Memory]`;

const DEFAULT_GENERATION_PROMPT = `Ты скрытый сценарист roleplay-истории. Твоя задача — не писать следующий ответ персонажа, а обновить долгосрочный скрытый план истории.

Используй текущий план, недавнюю историю, статус персонажа и внешнее событие, если оно есть.

Сделай план живым, но не рельсовым. Не отменяй неожиданные события. Если произошло событие типа катастрофы, удачи, вмешательства NPC или случайного поворота, перестрой дальнейшую дугу так, будто это теперь часть канона.

Не раскрывай план игроку напрямую. План предназначен только для скрытой режиссёрской установки модели.

Данные для работы:

Имя персонажа: {{characterName}}
Имя пользователя: {{userName}}
Количество сообщений в чате: {{messageCount}}

Текущий план:
{{currentPlan}}

Недавний чат:
{{recentChat}}

Текущий статусный блок:
{{statusBlock}}

Внешнее событие:
{{eventNote}}

Верни только обновлённый план в следующей структуре:

[СЦЕНАРИСТ: скрытый план]

Текущая драматическая дуга:
...

Ближайший горизонт, 1-5 RP-сообщений:
- ...

Средний горизонт, 5-20 RP-сообщений:
- ...

Дальний горизонт, 20-60 RP-сообщений:
- ...

Скрытые действия NPC:
- ...

Отложенные последствия:
- ...

Скрытые угрозы:
- ...

Скрытые возможности:
- ...

Правила ведения:
- Не раскрывать план напрямую.
- Не рельсить игрока.
- Подавать события через естественные зацепки.
- Уважать выбор игрока.
- Учитывать неожиданные события как канон, а не откатывать их.`;

const DEFAULT_SETTINGS = {
    enabled: true,
    autoGenerate: true,
    replanEvery: 30,
    replanAfterExternalEvent: true,
    injectPlan: true,
    injectionPosition: 'before_prompt',
    injectionDepth: 4,
    generationPrompt: DEFAULT_GENERATION_PROMPT,
    includeCheckpointSummaries: true,
    includeWorldInfo: true,
    applyRegexToPlannerRawBlock: true,
    autoRecentChatCount: true,
    recentChatMessages: 30,
    maxGenerationLength: 1000,
    connectionProfile: '',
};

const DEFAULT_STATE = {
    currentPlan: '',
    rpMessagesSinceLastPlan: 0,
    lastPlannedMessageId: -1,
    lastPlanGeneratedAt: '',
    pendingEvent: false,
    pendingEventType: '',
    pendingEventNote: '',
    pendingEventSource: '',
};

const runtime = {
    isGenerating: false,
    queuedReplan: false,
    abortRequested: false,
    lastError: '',
    lastAutoReplanSignature: '',
    lastSeenChatKey: '',
};

let initialized = false;
let lifecycleRegistered = false;
let connectionProfilesActive;

const saveMetadataDebounced = debounce(async () => await getContext().saveMetadata(), 1000);

function getMetadataRoot() {
    const context = getContext();

    if (!context) {
        return null;
    }

    if (context.chatMetadata && typeof context.chatMetadata === 'object') {
        return context.chatMetadata;
    }

    if (context.chat_metadata && typeof context.chat_metadata === 'object') {
        return context.chat_metadata;
    }

    context.chatMetadata = {};
    return context.chatMetadata;
}

function ensureSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] ?? {};

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }

    return extension_settings[MODULE_NAME];
}

function getSettings() {
    return ensureSettings();
}

function getRawChatState() {
    const metadata = getMetadataRoot();
    const stored = metadata?.[STATE_KEY];
    return stored && typeof stored === 'object' ? stored : {};
}

function getChatState() {
    return { ...DEFAULT_STATE, ...getRawChatState() };
}

function writeChatState(patch, persistMode = 'debounced') {
    const context = getContext();
    const metadata = getMetadataRoot();
    const nextState = { ...getChatState(), ...patch };

    if (!context || !metadata) {
        return Promise.resolve(nextState);
    }

    metadata[STATE_KEY] = nextState;

    if (persistMode === 'immediate') {
        return context.saveMetadata().then(() => nextState);
    }

    if (persistMode === 'debounced') {
        saveMetadataDebounced();
    }

    return Promise.resolve(nextState);
}

function hasActiveChat() {
    const context = getContext();
    return context.groupId || context.characterId !== undefined;
}

function getActiveChatKey() {
    const context = getContext();

    if (!context) {
        return '';
    }

    if (context.chatId !== undefined && context.chatId !== null && String(context.chatId).trim()) {
        return `chat:${String(context.chatId)}`;
    }

    if (context.groupId !== undefined && context.groupId !== null && String(context.groupId).trim()) {
        return `group:${String(context.groupId)}`;
    }

    if (context.characterId !== undefined && context.characterId !== null) {
        return `character:${String(context.characterId)}`;
    }

    return '';
}

function getPanel() {
    return document.getElementById(PANEL_ID);
}

function getExtensionDirectory() {
    const indexPath = new URL(import.meta.url).pathname;
    return indexPath.substring(0, indexPath.lastIndexOf('/'));
}

function getPlanTextarea() {
    return document.getElementById('stsw-current-plan');
}

function getCurrentPlanText() {
    return getPlanTextarea()?.value ?? getChatState().currentPlan ?? '';
}

function chatHasPlan(state = getChatState()) {
    return Boolean(String(getCurrentPlanText() ?? '').trim() || String(state?.currentPlan ?? '').trim());
}

function checkConnectionProfilesActive() {
    if (connectionProfilesActive === undefined) {
        connectionProfilesActive = $('#sys-settings-button').find('#connection_profiles').length > 0;
    }

    return connectionProfilesActive;
}

async function getCurrentConnectionProfile() {
    if (!checkConnectionProfilesActive()) {
        return '';
    }

    try {
        const context = getContext();
        const result = await context.executeSlashCommandsWithOptions('/profile');
        return String(result?.pipe ?? '').trim();
    } catch (error) {
        console.warn(`${MODULE_NAME}: /profile failed`, error);
        return '';
    }
}

async function getConnectionProfiles() {
    if (!checkConnectionProfilesActive()) {
        return [];
    }

    try {
        const context = getContext();
        const result = await context.executeSlashCommandsWithOptions('/profile-list');
        const parsed = JSON.parse(String(result?.pipe ?? '[]'));
        return Array.isArray(parsed) ? parsed.map(item => String(item)) : [];
    } catch (error) {
        console.warn(`${MODULE_NAME}: /profile-list failed`, error);
        return [];
    }
}

async function setConnectionProfile(name) {
    if (!checkConnectionProfilesActive()) {
        return;
    }

    const target = String(name ?? '').trim();

    if (!target) {
        return;
    }

    const current = await getCurrentConnectionProfile();

    if (current === target) {
        return;
    }

    const context = getContext();
    await context.executeSlashCommandsWithOptions(`/profile ${target}`);
}

async function updateConnectionProfileDropdown() {
    const row = document.getElementById('stsw-connection-profile-row');
    const select = document.getElementById('stsw-connection-profile');

    if (!(select instanceof HTMLSelectElement)) {
        return;
    }

    if (!checkConnectionProfilesActive()) {
        if (row instanceof HTMLElement) {
            row.style.display = 'none';
        }

        return;
    }

    if (row instanceof HTMLElement) {
        row.style.display = '';
    }

    const settings = getSettings();
    const selected = String(settings.connectionProfile ?? '');
    const profiles = await getConnectionProfiles();
    const uniqueProfiles = [...new Set(profiles)];

    select.innerHTML = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Same as Current';
    select.appendChild(defaultOption);

    for (const profileName of uniqueProfiles) {
        const option = document.createElement('option');
        option.value = profileName;
        option.textContent = profileName;
        select.appendChild(option);
    }

    select.value = selected;
    select.disabled = false;
}

async function runWithSelectedConnectionProfile(task) {
    const settings = getSettings();
    const desired = String(settings.connectionProfile ?? '').trim();

    if (!desired || !checkConnectionProfilesActive()) {
        return await task();
    }

    const current = await getCurrentConnectionProfile();
    let switched = false;

    try {
        if (current !== desired) {
            await setConnectionProfile(desired);
            switched = true;
        }

        return await task();
    } finally {
        if (switched && current) {
            try {
                await setConnectionProfile(current);
            } catch (error) {
                console.error(`${MODULE_NAME}: failed to restore connection profile`, error);
            }
        }
    }
}

function setCurrentPlanText(value) {
    const textarea = getPlanTextarea();

    if (textarea) {
        textarea.value = value ?? '';
    }
}

function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
}

function getInjectionConfig(positionName, depthValue) {
    if (positionName === 'in_chat') {
        return {
            position: extension_prompt_types.IN_CHAT,
            depth: clampNumber(depthValue, 0, 9999, DEFAULT_SETTINGS.injectionDepth),
        };
    }

    if (positionName === 'in_prompt') {
        return {
            position: extension_prompt_types.IN_PROMPT,
            depth: 0,
        };
    }

    return {
        position: extension_prompt_types.BEFORE_PROMPT,
        depth: 0,
    };
}

function formatInjectedPlan(planText) {
    return `[СКРЫТЫЙ СЦЕНАРНЫЙ ПЛАН / НЕ ПОКАЗЫВАТЬ ИГРОКУ]

Ты должен использовать этот план как режиссёрскую ориентацию, но не раскрывать его напрямую.
Не рельсь игрока. Не заставляй персонажей делать невозможное. Используй план через намёки, подготовку событий, NPC-инициативу, последствия и естественные зацепки.

<currentPlan>
${planText.trim()}
</currentPlan>`;
}

function updateInjection() {
    const context = getContext();
    const settings = getSettings();
    const state = getChatState();
    const planText = getCurrentPlanText().trim() || state.currentPlan.trim();

    if (!hasActiveChat() || !settings.enabled || !settings.injectPlan || !planText) {
        context.setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, 0, false, extension_prompt_roles.SYSTEM);
        return;
    }

    const injection = getInjectionConfig(settings.injectionPosition, settings.injectionDepth);
    context.setExtensionPrompt(
        MODULE_NAME,
        formatInjectedPlan(planText),
        injection.position,
        injection.depth,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function isRoleplayAssistantMessage(message) {
    if (!message || message.is_user || message.is_system || message.extra?.isSmallSys) {
        return false;
    }

    const rawText = String(message.mes ?? message.message ?? message.content ?? '');
    return !rawText.includes(STCS_HIDDEN_BLOCK_MARKER);
}

function hasHiddenStcsBlock(message) {
    const rawText = String(message?.mes ?? message?.message ?? message?.content ?? '');
    return rawText.includes(STCS_HIDDEN_BLOCK_MARKER);
}

function computeRpMetrics(chat, state) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return { count: 0, latestRpMessageId: -1 };
    }

    const lastPlannedMessageId = Number.isInteger(state.lastPlannedMessageId) ? state.lastPlannedMessageId : -1;
    const startIndex = Math.max(0, Math.min(chat.length, lastPlannedMessageId + 1));
    let count = 0;
    let latestRpMessageId = -1;

    for (let index = startIndex; index < chat.length; index++) {
        if (isRoleplayAssistantMessage(chat[index])) {
            count += 1;
            latestRpMessageId = index;
        }
    }

    return { count, latestRpMessageId };
}

function formatTimestamp(value) {
    if (!value) {
        return 'Never';
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function formatEventNote(state) {
    if (!state.pendingEvent) {
        return '';
    }

    const pieces = [];

    if (state.pendingEventType) {
        pieces.push(`type: ${state.pendingEventType}`);
    }

    if (state.pendingEventSource) {
        pieces.push(`source: ${state.pendingEventSource}`);
    }

    if (state.pendingEventNote) {
        pieces.push(`note: ${state.pendingEventNote}`);
    }

    return pieces.join('\n');
}

function extractStatusBlock(text) {
    const value = String(text ?? '');

    if (!value) {
        return '';
    }

    const lines = value.split(/\r?\n/);
    const startIndex = lines.findIndex(line => /(?:Состояние\s*:|\[Статус\])/i.test(line));

    if (startIndex < 0) {
        return '';
    }

    const block = [];

    for (let index = startIndex; index < lines.length; index++) {
        const line = lines[index];

        if (index > startIndex && !line.trim()) {
            break;
        }

        if (index > startIndex && /^[A-ZА-ЯЁ][^:]{0,80}:$/.test(line.trim())) {
            break;
        }

        block.push(line);
    }

    return block.join('\n').trim();
}

function shouldApplyRegexToPlannerRawBlock() {
    return !!getSettings().applyRegexToPlannerRawBlock;
}

function getPlannerMessageDepth(chat, index) {
    return Math.max(0, Number(chat?.length || 0) - Number(index || 0) - 1);
}

function getPlannerMessageText(message, index, chat, options = {}) {
    const { applyRegex = shouldApplyRegexToPlannerRawBlock() } = options;
    const text = String(message?.mes ?? message?.message ?? message?.content ?? '');

    if (!applyRegex) {
        return text;
    }

    try {
        const placement = message?.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
        const depth = getPlannerMessageDepth(chat, index);

        return getRegexedString(text, placement, {
            isPrompt: true,
            depth,
        });
    } catch (error) {
        console.warn(`${MODULE_NAME}: failed to apply regex to planner message ${index}`, error);
        return text;
    }
}

function findLatestStatusBlock(chat, options = {}) {
    if (!Array.isArray(chat)) {
        return '';
    }

    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];

        if (message?.is_user || message?.is_system) {
            continue;
        }

        const block = extractStatusBlock(getPlannerMessageText(message, index, chat, options));

        if (block) {
            return block;
        }
    }

    return '';
}

function formatRecentChatMessage(message, fallbackUserName, fallbackCharacterName) {
    const speaker = message.is_user
        ? (message.name || fallbackUserName || 'User')
        : (message.name || fallbackCharacterName || 'Assistant');

    return `${speaker}: ${String(message.mes ?? '').trim()}`;
}

function normalizeWorldInfoText(value) {
    if (typeof value === 'string') {
        return value.trim();
    }

    if (Array.isArray(value)) {
        return value.map(item => String(item ?? '')).join('\n').trim();
    }

    return '';
}

function collectWorldInfoLikeStrings(root, maxDepth = 4) {
    const out = [];
    const seen = new WeakSet();
    const keyPattern = /(world.?info|lorebook|lore|wi)/i;
    const denyKeyPattern = /(token|count|budget|max|depth|order|role|position|id|uid|hash|index)/i;

    const walk = (value, depth, keyHint = '') => {
        if (depth > maxDepth || value === null || value === undefined) {
            return;
        }

        if (typeof value === 'string') {
            const text = value.trim();

            if (!text) {
                return;
            }

            const keyOk = keyPattern.test(String(keyHint || ''));
            const looksStructuredWi = /\[World Info\]|\[End World Info\]/i.test(text);

            if (keyOk || looksStructuredWi) {
                out.push(text);
            }

            return;
        }

        if (typeof value !== 'object') {
            return;
        }

        if (seen.has(value)) {
            return;
        }

        seen.add(value);

        if (Array.isArray(value)) {
            for (const item of value) {
                walk(item, depth + 1, keyHint);
            }

            return;
        }

        for (const [key, nestedValue] of Object.entries(value)) {
            const hint = String(key || '');

            if (denyKeyPattern.test(hint) && !keyPattern.test(hint)) {
                continue;
            }

            walk(nestedValue, depth + 1, hint);
        }
    };

    walk(root, 0, '');

    return out
        .map(text => String(text || '').trim())
        .filter(Boolean)
        .sort((left, right) => right.length - left.length);
}

function getLatestItemizedPromptEntry() {
    if (!Array.isArray(itemizedPrompts) || itemizedPrompts.length === 0) {
        return null;
    }

    let latest = null;
    let latestMesId = -1;

    for (const entry of itemizedPrompts) {
        const mesId = Number(entry?.mesId);

        if (Number.isInteger(mesId) && mesId >= latestMesId) {
            latestMesId = mesId;
            latest = entry;
        } else if (!latest) {
            latest = entry;
        }
    }

    return latest;
}

function getWorldInfoFromLatestItemizedEntry() {
    const latest = getLatestItemizedPromptEntry();

    if (!latest) {
        return '';
    }

    const directFields = [
        latest.worldInfoString,
        latest.worldInfo,
        latest.world_info,
        latest.wiString,
        latest.wi,
    ];

    for (const field of directFields) {
        const normalized = normalizeWorldInfoText(field);

        if (normalized) {
            return normalized;
        }
    }

    const deepMatches = collectWorldInfoLikeStrings(latest, 4);
    return deepMatches[0] || '';
}

function buildChatForWorldInfoScan() {
    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const lines = chat
        .filter(message => !message?.is_system)
        .map(message => formatRecentChatMessage(message, context.name1, context.name2));

    const hasUserMessage = chat.some(message => message?.is_user);

    if (!hasUserMessage) {
        const userName = String(context.name1 || 'User').trim() || 'User';
        lines.push(`${userName}:`);
    }

    return lines.reverse();
}

async function getFullWorldInfoText() {
    const direct = getWorldInfoFromLatestItemizedEntry();

    if (direct) {
        return direct;
    }

    if (Array.isArray(itemizedPrompts) && itemizedPrompts.length > 0) {
        let latestIndex = -1;
        let latestMesId = -1;

        for (let index = 0; index < itemizedPrompts.length; index++) {
            const mesId = Number(itemizedPrompts[index]?.mesId);

            if (!Number.isInteger(mesId)) {
                continue;
            }

            if (mesId >= latestMesId) {
                latestMesId = mesId;
                latestIndex = index;
            }
        }

        if (latestIndex >= 0 && latestMesId >= 0) {
            try {
                const params = await itemizedParams(itemizedPrompts, latestIndex, latestMesId);

                if (params && typeof params === 'object') {
                    const paramFields = [
                        params.worldInfoString,
                        params.worldInfo,
                        params.world_info,
                        params.wiString,
                        params.wi,
                    ];

                    for (const field of paramFields) {
                        const normalized = normalizeWorldInfoText(field);

                        if (normalized) {
                            return normalized;
                        }
                    }

                    const deepMatches = collectWorldInfoLikeStrings(params, 5);

                    if (deepMatches.length) {
                        return deepMatches[0];
                    }
                }
            } catch (error) {
                console.warn(`${MODULE_NAME}: failed reading World Info from itemized params`, error);
            }
        }
    }

    try {
        const context = getContext();
        const chatForWI = buildChatForWorldInfoScan();
        const maxContext = Number(context.maxContext || 0);

        if (Array.isArray(chatForWI) && chatForWI.length > 0 && maxContext > 0) {
            const globalScanData = { trigger: 'normal' };

            for (const dryRun of [true, false]) {
                const wiResult = await getWorldInfoPrompt(chatForWI, maxContext, dryRun, globalScanData);
                const fromEngine = normalizeWorldInfoText(wiResult?.worldInfoString)
                    || normalizeWorldInfoText(wiResult?.worldInfoBefore)
                    || normalizeWorldInfoText(wiResult?.worldInfoAfter);

                if (fromEngine) {
                    return fromEngine;
                }
            }
        }
    } catch (error) {
        console.warn(`${MODULE_NAME}: failed reading World Info from WI engine fallback`, error);
    }

    return '';
}

async function countTextTokens(text) {
    const context = getContext();
    return await context.getTokenCountAsync(String(text ?? ''), 0);
}

function getRecentChatCandidates() {
    const context = getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];

    return chat
        .map((message, index) => ({ message, index }))
        .filter(entry => !entry.message?.is_system)
        .filter(entry => !hasHiddenStcsBlock(entry.message))
        .map(entry => {
            const text = getPlannerMessageText(entry.message, entry.index, chat);
            const speaker = entry.message.is_user
                ? (entry.message.name || context.name1 || 'User')
                : (entry.message.name || context.name2 || 'Assistant');

            return `${speaker}: ${String(text ?? '').trim()}`;
        });
}

async function resolveRecentChatText(worldInfoText = '', checkpointMemoryText = '') {
    const context = getContext();
    const settings = getSettings();
    const state = getChatState();
    const candidates = getRecentChatCandidates();

    if (!settings.autoRecentChatCount) {
        return candidates.slice(-settings.recentChatMessages).join('\n\n');
    }

    const totalBudget = Number(context.maxContext || 0);

    if (!(totalBudget > 0)) {
        return candidates.slice(-settings.recentChatMessages).join('\n\n');
    }

    const baseVariables = {
        currentPlan: getCurrentPlanText().trim() || state.currentPlan.trim() || '(плана ещё нет)',
        statusBlock: findLatestStatusBlock(context.chat) || '(статусный блок не найден)',
        eventNote: formatEventNote(state) || '(нет внешнего события)',
        characterName: context.name2 || '',
        userName: context.name1 || '',
        messageCount: String(Array.isArray(context.chat) ? context.chat.length : 0),
        recentChat: '',
    };

    const basePrompt = applyTemplate(settings.generationPrompt, baseVariables);
    const basePromptTokens = await countTextTokens(basePrompt);
    const checkpointMemoryTokens = checkpointMemoryText
        ? await countTextTokens(checkpointMemoryText)
        : 0;
    const worldInfoBlock = settings.includeWorldInfo && worldInfoText
        ? ['[World Info]', worldInfoText, '[End World Info]'].join('\n')
        : '';
    const worldInfoTokens = worldInfoBlock ? await countTextTokens(worldInfoBlock) : 0;
    const availableRecentChatTokens = totalBudget - basePromptTokens - checkpointMemoryTokens - worldInfoTokens - AUTO_RECENT_CHAT_SAFETY_BUFFER_TOKENS;

    if (availableRecentChatTokens <= 0) {
        return '';
    }

    const selected = [];

    for (let index = candidates.length - 1; index >= 0; index--) {
        const candidateText = [candidates[index], ...selected].join('\n\n');
        const candidateTokens = await countTextTokens(candidateText);

        if (candidateTokens > availableRecentChatTokens) {
            break;
        }

        selected.unshift(candidates[index]);
    }

    return selected.join('\n\n');
}

async function buildGenerationVariables(worldInfoText = '', checkpointMemoryText = '') {
    const context = getContext();
    const state = getChatState();
    const recentChat = await resolveRecentChatText(worldInfoText, checkpointMemoryText);

    return {
        recentChat,
        currentPlan: getCurrentPlanText().trim() || state.currentPlan.trim() || '(плана ещё нет)',
        statusBlock: findLatestStatusBlock(context.chat) || '(статусный блок не найден)',
        eventNote: formatEventNote(state) || '(нет внешнего события)',
        characterName: context.name2 || '',
        userName: context.name1 || '',
        messageCount: String(Array.isArray(context.chat) ? context.chat.length : 0),
    };
}

function applyTemplate(template, variables) {
    return String(template ?? '').replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => String(variables[key] ?? ''));
}

function getCheckpointSummarizeState() {
    const metadata = getMetadataRoot();
    const state = metadata?.[CHECKPOINT_SUMMARIZE_METADATA_KEY];
    return state && typeof state === 'object' ? state : null;
}

function getInjectableLockedCheckpointBlocks(checkpointState) {
    const blocks = Array.isArray(checkpointState?.blocks) ? checkpointState.blocks : [];
    return blocks.filter(block => block?.locked === true && block?.inject !== false);
}

function isRangeCheckpoint(block) {
    const start = Number(block?.startIndex);
    const end = Number(block?.endIndex);
    return !block?.memoryOnly && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start;
}

function buildCheckpointBlocksText(checkpointState) {
    const blocks = getInjectableLockedCheckpointBlocks(checkpointState);

    if (!blocks.length) {
        return '';
    }

    return blocks
        .map((block, index) => {
            const checkpointNumber = String(index + 1).padStart(3, '0');
            const summary = String(block?.summary ?? '').trim();
            const rangeLabel = isRangeCheckpoint(block)
                ? `${block.startIndex}-${block.endIndex}`
                : 'memory-only';

            return `[Checkpoint ${checkpointNumber} | messages ${rangeLabel}]\n${summary}`;
        })
        .join('\n\n');
}

function buildCheckpointMemoryText() {
    const settings = getSettings();

    if (!settings.includeCheckpointSummaries) {
        return '';
    }

    const checkpointState = getCheckpointSummarizeState();
    const blocksText = buildCheckpointBlocksText(checkpointState);

    if (!blocksText.trim()) {
        return '';
    }

    const template = checkpointState?.settings?.injectionTemplate || DEFAULT_CHECKPOINT_INJECTION_TEMPLATE;
    return applyTemplate(template, {
        checkpoint_blocks: blocksText,
    }).trim();
}

async function buildPlannerPrompt() {
    const settings = getSettings();
    const checkpointMemory = buildCheckpointMemoryText();
    const worldInfo = settings.includeWorldInfo ? await getFullWorldInfoText() : '';
    const variables = await buildGenerationVariables(worldInfo, checkpointMemory);
    const basePrompt = applyTemplate(settings.generationPrompt, variables);
    const blocks = [];

    if (checkpointMemory) {
        blocks.push(checkpointMemory);
    }

    if (settings.includeWorldInfo && worldInfo) {
        blocks.push([
            '[World Info]',
            worldInfo,
            '[End World Info]',
        ].join('\n'));
    }

    blocks.push(basePrompt);
    return blocks.join('\n\n');
}

function renderStatus() {
    const panel = getPanel();

    if (!panel) {
        return;
    }

    const settings = getSettings();
    const state = getChatState();
    const statusText = runtime.isGenerating
        ? 'Generating hidden plan...'
        : runtime.queuedReplan
            ? 'Queued replan pending'
            : runtime.lastError
                ? 'Last generation failed'
                : 'Idle';

    panel.querySelector('#stsw-status-last-plan').textContent = state.currentPlan.trim() ? formatTimestamp(state.lastPlanGeneratedAt) : 'Never';
    panel.querySelector('#stsw-status-last-message').textContent = state.lastPlannedMessageId >= 0 ? String(state.lastPlannedMessageId) : 'None';
    panel.querySelector('#stsw-status-rp-count').textContent = String(state.rpMessagesSinceLastPlan);
    panel.querySelector('#stsw-status-pending-event').textContent = state.pendingEvent ? 'Yes' : 'No';
    panel.querySelector('#stsw-status-enabled').textContent = settings.enabled ? 'Yes' : 'No';
    panel.querySelector('#stsw-status-injection').textContent = settings.injectPlan ? 'Yes' : 'No';

    const runtimeNode = panel.querySelector('#stsw-runtime-status');
    runtimeNode.textContent = statusText;
    runtimeNode.classList.toggle('stsw-ok', !runtime.lastError);
    runtimeNode.classList.toggle('stsw-error', !!runtime.lastError);

    const errorNode = panel.querySelector('#stsw-last-error');
    errorNode.textContent = runtime.lastError || 'None';
    errorNode.classList.toggle('stsw-error', !!runtime.lastError);

    const generateButton = panel.querySelector('#stsw-generate-now');
    generateButton.textContent = runtime.isGenerating ? 'Cancel' : 'Generate/Replan Now';
}

function updateRecentChatInputState() {
    const panel = getPanel();

    if (!panel) {
        return;
    }

    const settings = getSettings();
    const input = panel.querySelector('#stsw-recent-chat-messages');

    input.disabled = !!settings.autoRecentChatCount;

    if (settings.autoRecentChatCount) {
        input.value = '';
        input.placeholder = 'auto';
    } else {
        input.value = settings.recentChatMessages;
        input.placeholder = '';
    }
}

function fillFormFromState() {
    const panel = getPanel();

    if (!panel) {
        return;
    }

    const settings = getSettings();
    const state = getChatState();

    panel.querySelector('#stsw-enabled').checked = !!settings.enabled;
    panel.querySelector('#stsw-auto-generate').checked = !!settings.autoGenerate;
    panel.querySelector('#stsw-auto-recent-chat-count').checked = !!settings.autoRecentChatCount;
    panel.querySelector('#stsw-replan-on-event').checked = !!settings.replanAfterExternalEvent;
    panel.querySelector('#stsw-inject-plan').checked = !!settings.injectPlan;
    panel.querySelector('#stsw-include-checkpoint-summaries').checked = !!settings.includeCheckpointSummaries;
    panel.querySelector('#stsw-include-world-info').checked = !!settings.includeWorldInfo;
    panel.querySelector('#stsw-apply-regex-raw-block').checked = !!settings.applyRegexToPlannerRawBlock;
    panel.querySelector('#stsw-replan-every').value = settings.replanEvery;
    panel.querySelector('#stsw-injection-position').value = settings.injectionPosition;
    panel.querySelector('#stsw-injection-depth').value = settings.injectionDepth;
    panel.querySelector('#stsw-generation-prompt').value = settings.generationPrompt;
    panel.querySelector('#stsw-max-generation-length').value = settings.maxGenerationLength;
    panel.querySelector('#stsw-connection-profile').value = String(settings.connectionProfile ?? '');
    panel.querySelector('#stsw-current-plan').value = state.currentPlan ?? '';
    updateRecentChatInputState();
    renderStatus();
}

async function savePlanFromEditor() {
    const planText = getCurrentPlanText();
    await writeChatState({ currentPlan: planText }, 'immediate');
    updateInjection();
    renderStatus();
    toastr.success('Screenwriter plan saved');
}

async function clearPlan() {
    setCurrentPlanText('');
    await writeChatState({ currentPlan: '' }, 'immediate');
    updateInjection();
    renderStatus();
    toastr.info('Screenwriter plan cleared');
}

async function copyPlan() {
    const planText = getCurrentPlanText();
    await navigator.clipboard.writeText(planText);
    toastr.success('Screenwriter plan copied');
}

async function syncRpCounter({ triggerReplan = true } = {}) {
    const context = getContext();

    if (!hasActiveChat()) {
        updateInjection();
        renderStatus();
        return;
    }

    const state = getChatState();
    const settings = getSettings();
    const metrics = computeRpMetrics(context.chat, state);

    if (metrics.count !== state.rpMessagesSinceLastPlan) {
        await writeChatState({ rpMessagesSinceLastPlan: metrics.count }, 'debounced');
    }

    renderStatus();

    if (!triggerReplan || runtime.isGenerating || !settings.enabled || !settings.autoGenerate) {
        updateInjection();
        return;
    }

    if (metrics.count < settings.replanEvery) {
        runtime.lastAutoReplanSignature = '';
        updateInjection();
        return;
    }

    const signature = `${context.chatId ?? 'no-chat'}:${state.lastPlannedMessageId}:${metrics.latestRpMessageId}:${metrics.count}`;

    if (runtime.lastAutoReplanSignature === signature) {
        updateInjection();
        return;
    }

    runtime.lastAutoReplanSignature = signature;
    updateInjection();
    await queueGenerate('threshold');
}

async function generatePlan(reason = 'manual') {
    const settings = getSettings();
    const context = getContext();

    if (!settings.enabled) {
        toastr.warning('Screenwriter is disabled');
        return;
    }

    if (!hasActiveChat()) {
        toastr.warning('Open a chat first');
        return;
    }

    runtime.isGenerating = true;
    runtime.abortRequested = false;
    runtime.lastError = '';
    renderStatus();

    try {
        const state = getChatState();
        const plan = await runWithSelectedConnectionProfile(async () => {
            const prompt = await buildPlannerPrompt();
            return await generateQuietPrompt({
                quietPrompt: prompt,
                responseLength: settings.maxGenerationLength,
                removeReasoning: true,
                trimToSentence: false,
            });
        });

        if (runtime.abortRequested) {
            throw new Error('Generation cancelled');
        }

        if (!String(plan ?? '').trim()) {
            throw new Error('Planner returned an empty plan');
        }

        const lastMessageId = Array.isArray(context.chat) && context.chat.length > 0 ? context.chat.length - 1 : -1;
        const nextState = {
            currentPlan: String(plan).trim(),
            rpMessagesSinceLastPlan: 0,
            lastPlannedMessageId: lastMessageId,
            lastPlanGeneratedAt: new Date().toISOString(),
            pendingEvent: false,
            pendingEventType: '',
            pendingEventNote: '',
            pendingEventSource: '',
        };

        await writeChatState(nextState, 'immediate');
        setCurrentPlanText(nextState.currentPlan);
        runtime.lastAutoReplanSignature = '';
        updateInjection();
        renderStatus();

        if (reason === 'manual' || reason === 'external_event' || reason === 'chat_entry') {
            toastr.success('Screenwriter plan updated');
        }

        return nextState.currentPlan;
    } catch (error) {
        runtime.lastError = error instanceof Error ? error.message : String(error);

        if (runtime.lastError === 'Generation cancelled') {
            toastr.info('Screenwriter generation cancelled');
        } else {
            console.error(`${MODULE_NAME}: generation failed`, error);
            toastr.error(`Screenwriter generation failed: ${runtime.lastError}`);
        }
    } finally {
        runtime.isGenerating = false;
        renderStatus();

        if (runtime.queuedReplan) {
            runtime.queuedReplan = false;
            queueGenerate('queued');
        }
    }
}

async function queueGenerate(reason = 'manual') {
    if (runtime.isGenerating) {
        runtime.queuedReplan = true;
        renderStatus();
        return;
    }

    return await generatePlan(reason);
}

async function setPendingEvent({ type = '', note = '', source = '' } = {}, requestImmediate = false) {
    const patch = {
        pendingEvent: Boolean(type || note || source),
        pendingEventType: String(type ?? ''),
        pendingEventNote: String(note ?? ''),
        pendingEventSource: String(source ?? ''),
    };

    await writeChatState(patch, 'immediate');
    renderStatus();

    if (!hasActiveChat()) {
        return patch;
    }

    const settings = getSettings();

    if ((requestImmediate || settings.replanAfterExternalEvent) && settings.enabled) {
        await queueGenerate('external_event');
    }

    return patch;
}

function handleSettingToggle(key, value) {
    const settings = getSettings();
    settings[key] = value;
    saveSettingsDebounced();
    updateRecentChatInputState();
    updateInjection();
    renderStatus();
}

function handleSettingNumber(key, value, min, max) {
    const settings = getSettings();
    settings[key] = clampNumber(value, min, max, DEFAULT_SETTINGS[key]);
    saveSettingsDebounced();
    updateRecentChatInputState();
    updateInjection();
    renderStatus();
}

function bindEvents() {
    const panel = getPanel();

    if (!panel || panel.dataset.bound === 'true') {
        return;
    }

    panel.dataset.bound = 'true';

    panel.querySelector('#stsw-enabled').addEventListener('input', event => {
        handleSettingToggle('enabled', event.target.checked);
        syncRpCounter({ triggerReplan: true });
    });

    panel.querySelector('#stsw-auto-generate').addEventListener('input', event => {
        handleSettingToggle('autoGenerate', event.target.checked);
        syncRpCounter({ triggerReplan: true });
    });

    panel.querySelector('#stsw-auto-recent-chat-count').addEventListener('input', event => {
        handleSettingToggle('autoRecentChatCount', event.target.checked);
    });

    panel.querySelector('#stsw-replan-every').addEventListener('input', event => {
        handleSettingNumber('replanEvery', event.target.value, 1, 500);
        syncRpCounter({ triggerReplan: true });
    });

    panel.querySelector('#stsw-replan-on-event').addEventListener('input', event => {
        handleSettingToggle('replanAfterExternalEvent', event.target.checked);
    });

    panel.querySelector('#stsw-inject-plan').addEventListener('input', event => {
        handleSettingToggle('injectPlan', event.target.checked);
    });

    panel.querySelector('#stsw-include-world-info').addEventListener('input', event => {
        handleSettingToggle('includeWorldInfo', event.target.checked);
    });

    panel.querySelector('#stsw-include-checkpoint-summaries').addEventListener('input', event => {
        handleSettingToggle('includeCheckpointSummaries', event.target.checked);
    });

    panel.querySelector('#stsw-apply-regex-raw-block').addEventListener('input', event => {
        handleSettingToggle('applyRegexToPlannerRawBlock', event.target.checked);
    });

    panel.querySelector('#stsw-injection-position').addEventListener('input', event => {
        handleSettingToggle('injectionPosition', event.target.value);
    });

    panel.querySelector('#stsw-injection-depth').addEventListener('input', event => {
        handleSettingNumber('injectionDepth', event.target.value, 0, 9999);
    });

    panel.querySelector('#stsw-generation-prompt').addEventListener('input', event => {
        getSettings().generationPrompt = event.target.value;
        saveSettingsDebounced();
    });

    panel.querySelector('#stsw-connection-profile').addEventListener('change', event => {
        const settings = getSettings();
        settings.connectionProfile = String(event.target.value ?? '');
        saveSettingsDebounced();
    });

    panel.querySelector('#stsw-connection-profile').addEventListener('click', () => {
        void updateConnectionProfileDropdown();
    });

    panel.querySelector('#stsw-recent-chat-messages').addEventListener('input', event => {
        handleSettingNumber('recentChatMessages', event.target.value, 1, 200);
    });

    panel.querySelector('#stsw-max-generation-length').addEventListener('input', event => {
        handleSettingNumber('maxGenerationLength', event.target.value, 64, 4096);
    });

    panel.querySelector('#stsw-save-plan').addEventListener('click', async () => await savePlanFromEditor());
    panel.querySelector('#stsw-clear-plan').addEventListener('click', async () => await clearPlan());
    panel.querySelector('#stsw-copy-plan').addEventListener('click', async () => await copyPlan());
    panel.querySelector('#stsw-generate-now').addEventListener('click', async () => {
        if (runtime.isGenerating) {
            runtime.abortRequested = true;
            getContext().stopGeneration();
            return;
        }

        await queueGenerate('manual');
    });
}

async function renderUI() {
    const container = document.getElementById('extensions_settings2');

    if (!container) {
        return null;
    }

    document.querySelectorAll(`#${PANEL_ID}`).forEach(node => node.remove());

    const settingsPath = `${getExtensionDirectory()}/settings.html`;
    let settingsHtml = '';

    try {
        settingsHtml = await $.get(settingsPath);
    } catch (error) {
        console.error(`${MODULE_NAME}: failed to load settings template`, settingsPath, error);
        toastr.error(`Failed to load Screenwriter settings template: ${settingsPath}`);
        return null;
    }

    container.insertAdjacentHTML('beforeend', settingsHtml);
    return getPanel();
}

function installApi() {
    window.STScreenwriter = {
        requestReplan: async ({ type = '', note = '', source = '' } = {}) => await setPendingEvent({ type, note, source }, true),
        setEvent: async ({ type = '', note = '', source = '' } = {}) => await setPendingEvent({ type, note, source }, false),
        getPlan: () => getCurrentPlanText() || getChatState().currentPlan || '',
        setPlan: async text => {
            const value = String(text ?? '');
            setCurrentPlanText(value);
            await writeChatState({ currentPlan: value }, 'immediate');
            updateInjection();
            renderStatus();
            return value;
        },
        clearPlan: async () => await clearPlan(),
        generateNow: async () => await queueGenerate('manual'),
    };
}

async function refreshForChat() {
    const previousChatKey = runtime.lastSeenChatKey;
    const currentChatKey = getActiveChatKey();
    const isChatEntry = Boolean(currentChatKey) && currentChatKey !== previousChatKey;

    runtime.lastSeenChatKey = currentChatKey;

    await renderUI();
    bindEvents();
    await updateConnectionProfileDropdown();
    fillFormFromState();
    updateInjection();
    const state = getChatState();
    const shouldPromptForInitialPlan = isChatEntry && getSettings().enabled && !chatHasPlan(state);

    await syncRpCounter({ triggerReplan: !shouldPromptForInitialPlan });

    if (!shouldPromptForInitialPlan || runtime.isGenerating || !hasActiveChat()) {
        return;
    }

    const shouldGeneratePlan = window.confirm('Для этого чата у Screenwriter ещё нет плана. Сгенерировать его сейчас?');

    if (shouldGeneratePlan) {
        await queueGenerate('chat_entry');
    }
}

function registerLifecycle() {
    if (lifecycleRegistered) {
        return;
    }

    lifecycleRegistered = true;
    eventSource.on(event_types.APP_READY, refreshForChat);
    eventSource.on(event_types.CHAT_CHANGED, refreshForChat);
    eventSource.on(event_types.CHAT_LOADED, refreshForChat);
    eventSource.on(event_types.MESSAGE_RECEIVED, async () => await syncRpCounter({ triggerReplan: true }));
    eventSource.on(event_types.MESSAGE_SWIPED, async () => await syncRpCounter({ triggerReplan: true }));
    eventSource.on(event_types.MESSAGE_EDITED, async () => await syncRpCounter({ triggerReplan: true }));
    eventSource.on(event_types.MESSAGE_DELETED, async () => await syncRpCounter({ triggerReplan: false }));
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        if (runtime.isGenerating) {
            runtime.abortRequested = true;
        }
    });
}

export async function init() {
    if (initialized) {
        return;
    }

    initialized = true;
    ensureSettings();
    installApi();
    registerLifecycle();
    await refreshForChat();
}

jQuery(() => {
    void init();
});
