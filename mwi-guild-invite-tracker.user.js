// ==UserScript==
// @name         银河奶牛公会邀请助手
// @name:en      MWI Guild Invite Tracker
// @namespace    https://github.com/layu/mwi-guild-invite-tracker
// @version      0.2.0
// @description  被动记录排行榜资料查看、公会状态和原生公会邀请结果
// @description:en Passively records leaderboard profile views, guild status, and native guild invite outcomes
// @match        https://www.milkywayidle.com/*
// @match        https://www.milkywayidlecn.com/*
// @run-at       document-start
// @grant        GM_addElement
// @license      MIT
// ==/UserScript==


// ---- src/runtime/config.js ----
(function initConfig(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});

  app.config = Object.freeze({
    appId: "mwi-guild-invite-tracker",
    version: "0.1.0",
    schemaVersion: 1,
    databaseName: "mwi-guild-invite-tracker",
    databaseVersion: 1,
    bridgeMarker: "__MWI_GUILD_INVITE_TRACKER_BRIDGE_V1__",
    bridgeEvent: "mwi-git:protocol:v1",
    uiPrefix: "mwi-git",
    settingsKey: "mwi-git:settings:v1",
    lastIdentityKey: "mwi-git:last-identity:v1",
    profileTimeoutMs: 15_000,
    inviteTimeoutMs: 15_000,
    duplicateWindowMs: 1_250,
    staleProfileMs: 30 * 24 * 60 * 60 * 1000,
    maxImportBytes: 25 * 1024 * 1024,
    officialSocketHostPattern: /^api(?:-test)?\.milkywayidle(?:cn)?\.com$/i,
    observedTypes: Object.freeze([
      "init_character_data",
      "get_leaderboard",
      "leaderboard_updated",
      "view_profile",
      "profile_shared",
      "send_guild_invite",
      "info",
      "error",
      "guild_characters_updated"
    ])
  });
})(globalThis);

// ---- src/core.js ----
(function initCore(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});

  const OUTCOMES = new Set([
    "pending",
    "sent",
    "already_in_guild",
    "already_invited",
    "guild_full",
    "mode_mismatch",
    "not_found",
    "blocked",
    "rate_limited",
    "timeout",
    "ambiguous",
    "unknown_error"
  ]);

  const ERROR_OUTCOME = Object.freeze({
    "errorNotification.characterNameNotFound": "not_found",
    "errorNotification.characterAlreadyInGuild": "already_in_guild",
    "errorNotification.characterAlreadyInvited": "already_invited",
    "errorNotification.guildIsFull": "guild_full",
    "errorNotification.guildTypeMismatch": "mode_mismatch",
    "errorNotification.characterBlockError": "blocked",
    "errorNotification.requestSpamProtection": "rate_limited"
  });

  function normalizeName(value) {
    return typeof value === "string" ? value.trim().normalize("NFKC").toLocaleLowerCase() : "";
  }

  function safeString(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
  }

  function nullableNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function isoNow(clock) {
    return new Date(clock ? clock() : Date.now()).toISOString();
  }

  function uuid(randomUUID) {
    if (typeof randomUUID === "function") return randomUUID();
    if (root.crypto && typeof root.crypto.randomUUID === "function") return root.crypto.randomUUID();
    return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function playerKey(characterId, name) {
    const id = nullableNumber(characterId);
    return id === null ? `name:${normalizeName(name)}` : `character:${id}`;
  }

  function guildSnapshot(profile, observedAt) {
    const guildId = nullableNumber(profile && profile.guildId);
    const guildName = safeString(profile && profile.guildName).trim() || null;
    const guildRole = safeString(profile && profile.guildRole).trim() || null;
    const joined = guildId !== null || Boolean(guildName) || Boolean(guildRole);
    return {
      state: joined ? "joined" : "none",
      guildId,
      guildName,
      guildRole,
      observedAt,
      certainty: "profile"
    };
  }

  function mergeAliases(existing, incoming, currentName) {
    const aliases = new Map();
    for (const value of [...(existing || []), ...(incoming || [])]) {
      if (!value || normalizeName(value) === normalizeName(currentName)) continue;
      aliases.set(normalizeName(value), value);
    }
    return [...aliases.values()];
  }

  function laterIso(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return Date.parse(a) >= Date.parse(b) ? a : b;
  }

  function mergePlayer(existing, incoming) {
    if (!existing) return { ...incoming, nameAliases: [...(incoming.nameAliases || [])] };
    const existingLatest = existing.latestGuild && existing.latestGuild.observedAt;
    const incomingLatest = incoming.latestGuild && incoming.latestGuild.observedAt;
    const useIncomingGuild = incomingLatest && (!existingLatest || Date.parse(incomingLatest) >= Date.parse(existingLatest));
    const currentName = incoming.currentName || existing.currentName;
    const aliases = mergeAliases(
      [...(existing.nameAliases || []), existing.currentName],
      [...(incoming.nameAliases || []), incoming.currentName],
      currentName
    );
    return {
      ...existing,
      ...incoming,
      playerKey: incoming.characterId != null ? playerKey(incoming.characterId, currentName) : existing.playerKey,
      characterId: incoming.characterId != null ? nullableNumber(incoming.characterId) : existing.characterId,
      currentName,
      normalizedName: normalizeName(currentName),
      nameAliases: aliases,
      firstSeenAt:
        Date.parse(existing.firstSeenAt) <= Date.parse(incoming.firstSeenAt)
          ? existing.firstSeenAt
          : incoming.firstSeenAt,
      lastSeenAt: laterIso(existing.lastSeenAt, incoming.lastSeenAt),
      lastViewedAt: laterIso(existing.lastViewedAt, incoming.lastViewedAt),
      lastInvitedAt: laterIso(existing.lastInvitedAt, incoming.lastInvitedAt),
      latestGuild: useIncomingGuild ? incoming.latestGuild : existing.latestGuild
    };
  }

  function playerFromProfile(profile, viewedAt) {
    const name = safeString(profile && profile.name).trim();
    const characterId = nullableNumber(profile && profile.characterId);
    return {
      playerKey: playerKey(characterId, name),
      characterId,
      currentName: name,
      normalizedName: normalizeName(name),
      nameAliases: [],
      firstSeenAt: viewedAt,
      lastSeenAt: viewedAt,
      latestGuild: guildSnapshot(profile, viewedAt),
      lastViewedAt: viewedAt,
      lastInvitedAt: null
    };
  }

  function playerFromInvite(name, attemptedAt) {
    const currentName = safeString(name).trim();
    return {
      playerKey: playerKey(null, currentName),
      characterId: null,
      currentName,
      normalizedName: normalizeName(currentName),
      nameAliases: [],
      firstSeenAt: attemptedAt,
      lastSeenAt: attemptedAt,
      latestGuild: {
        state: "unknown",
        guildId: null,
        guildName: null,
        guildRole: null,
        observedAt: null,
        certainty: null
      },
      lastViewedAt: null,
      lastInvitedAt: attemptedAt
    };
  }

  function makeObservation(profile, context, viewedAt, randomUUID) {
    const player = playerFromProfile(profile, viewedAt);
    return {
      id: uuid(randomUUID),
      playerKey: player.playerKey,
      characterName: player.currentName,
      viewedAt,
      source: context && context.leaderboard ? "leaderboard" : (context && context.source) || "unknown",
      leaderboard: context && context.leaderboard ? structuredCloneSafe(context.leaderboard) : null,
      guildSnapshot: guildSnapshot(profile, viewedAt)
    };
  }

  function makeInviteEvent(name, attemptedAt, recruiter, linkedObservationId, randomUUID) {
    const normalizedName = normalizeName(name);
    return {
      id: uuid(randomUUID),
      playerKey: playerKey(null, name),
      requestedName: safeString(name).trim(),
      normalizedName,
      attemptedAt,
      confirmedAt: null,
      detectedAt: null,
      outcome: "pending",
      errorKey: null,
      correlation: null,
      source: "native_guild_form",
      recruiter: recruiter ? structuredCloneSafe(recruiter) : null,
      linkedObservationId: linkedObservationId || null
    };
  }

  function applyInviteOutcome(event, outcome, confirmedAt, correlation, errorKey) {
    const safeOutcome = OUTCOMES.has(outcome) ? outcome : "unknown_error";
    if (!event || event.outcome !== "pending") return event;
    return {
      ...event,
      outcome: safeOutcome,
      confirmedAt: confirmedAt || null,
      errorKey: errorKey || null,
      correlation: correlation || null
    };
  }

  function outcomeFromErrorKey(key) {
    return ERROR_OUTCOME[key] || "unknown_error";
  }

  function structuredCloneSafe(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function isIsoDate(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
  }

  function latestInviteForPlayer(events, key) {
    return (events || [])
      .filter((event) => event.playerKey === key)
      .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt))[0] || null;
  }

  function playerStatus(player, invite, now, staleMs) {
    if (invite && invite.outcome === "sent") return "invited";
    if (invite && invite.outcome !== "pending" && invite.outcome !== "sent") return "invite_failed";
    if (player.latestGuild && player.latestGuild.state === "joined") return "has_guild";
    if (player.latestGuild && player.latestGuild.state === "none") {
      const observed = Date.parse(player.latestGuild.observedAt || 0);
      if (observed && now - observed > staleMs) return "stale";
      return "no_guild";
    }
    return "unknown";
  }

  function filterPlayers(players, options, invites, observations) {
    const query = normalizeName(options && options.query);
    const status = options && options.status;
    const guildState = options && options.guildState;
    const inviteOutcome = options && options.inviteOutcome;
    const category = options && options.category;
    const days = Number(options && options.days) || 0;
    const sort = (options && options.sort) || "lastViewedAt";
    const direction = options && options.direction === "asc" ? 1 : -1;
    const inviteMap = new Map();
    for (const event of invites || []) {
      const previous = inviteMap.get(event.playerKey);
      if (!previous || Date.parse(event.attemptedAt) > Date.parse(previous.attemptedAt)) {
        inviteMap.set(event.playerKey, event);
      }
    }
    const observationMap = new Map();
    for (const event of observations || []) {
      if (!observationMap.has(event.playerKey)) observationMap.set(event.playerKey, []);
      observationMap.get(event.playerKey).push(event);
    }
    for (const events of observationMap.values()) {
      events.sort((a, b) => Date.parse(b.viewedAt) - Date.parse(a.viewedAt));
    }
    const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
    return (players || [])
      .filter((player) => {
        const haystack = [player.currentName, ...(player.nameAliases || [])].map(normalizeName);
        if (query && !haystack.some((name) => name.includes(query))) return false;
        const invite = inviteMap.get(player.playerKey);
        if (status && status !== "all" && playerStatus(player, invite, Date.now(), app.config.staleProfileMs) !== status) return false;
        if (guildState && guildState !== "all" && player.latestGuild?.state !== guildState) return false;
        if (inviteOutcome && inviteOutcome !== "all" && invite?.outcome !== inviteOutcome) return false;
        const playerObservations = observationMap.get(player.playerKey) || [];
        if (category && category !== "all" && !playerObservations.some((event) => event.leaderboard?.categoryHrid === category)) return false;
        if (cutoff) {
          const latestActivity = Math.max(Date.parse(player.lastViewedAt || 0) || 0, Date.parse(player.lastInvitedAt || 0) || 0);
          if (latestActivity < cutoff) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sort === "name") return direction * a.currentName.localeCompare(b.currentName);
        if (sort === "rank") {
          const rankFor = (player) => {
            const events = observationMap.get(player.playerKey) || [];
            const relevant = category && category !== "all"
              ? events.filter((event) => event.leaderboard?.categoryHrid === category)
              : events;
            const ranks = relevant.map((event) => Number(event.leaderboard?.rank)).filter(Number.isFinite);
            return ranks.length ? Math.min(...ranks) : Number.POSITIVE_INFINITY;
          };
          return direction * (rankFor(a) - rankFor(b));
        }
        const aValue = Date.parse(a[sort] || 0) || 0;
        const bValue = Date.parse(b[sort] || 0) || 0;
        return direction * (aValue - bValue);
      });
  }

  app.core = Object.freeze({
    OUTCOMES,
    ERROR_OUTCOME,
    normalizeName,
    nullableNumber,
    isoNow,
    uuid,
    playerKey,
    guildSnapshot,
    mergePlayer,
    laterIso,
    playerFromProfile,
    playerFromInvite,
    makeObservation,
    makeInviteEvent,
    applyInviteOutcome,
    outcomeFromErrorKey,
    isIsoDate,
    latestInviteForPlayer,
    playerStatus,
    filterPlayers,
    structuredCloneSafe
  });
})(globalThis);

// ---- src/localization.js ----
(function initLocalization(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const messages = {
    zh: {
      launcher: "招募档案",
      sidebar: "邀请助手",
      title: "招募档案",
      subtitle: "排行榜查看与公会邀请记录",
      close: "关闭",
      search: "搜索玩家",
      allStatuses: "全部状态",
      allGuildStates: "全部公会状态",
      allCategories: "全部排行榜",
      allInviteOutcomes: "全部邀请结果",
      allTime: "全部时间",
      last7Days: "最近 7 天",
      last30Days: "最近 30 天",
      last90Days: "最近 90 天",
      noGuild: "无公会",
      hasGuild: "有公会",
      invited: "已邀请",
      inviteFailed: "邀请失败",
      stale: "资料已过期",
      unknown: "未确认",
      sortRecentView: "最近查看",
      sortRecentInvite: "最近邀请",
      sortName: "玩家名称",
      sortRank: "最佳排名",
      exportJson: "导出完整备份",
      exportCsv: "导出 CSV",
      importJson: "导入备份",
      clear: "清空当前角色",
      deletePlayer: "删除该玩家记录",
      players: "候选人",
      observations: "查看记录",
      invites: "邀请记录",
      timeline: "时间线",
      emptyPlayers: "还没有记录。先在排行榜打开一名玩家的详细资料。",
      emptyTimeline: "选择一名玩家查看完整时间线。",
      viewed: "查看资料",
      inviteAttempt: "提交邀请",
      guildNone: "无公会",
      guildUnknown: "公会未知",
      rank: "排名",
      checkedAt: "检查于",
      outcome: "结果",
      pending: "等待确认",
      sent: "邀请成功",
      already_in_guild: "玩家已有公会",
      already_invited: "已经邀请过",
      guild_full: "公会已满",
      mode_mismatch: "游戏模式不匹配",
      not_found: "玩家不存在",
      blocked: "无法邀请该玩家",
      rate_limited: "操作过于频繁",
      timeout: "服务器响应超时",
      ambiguous: "结果无法可靠关联",
      unknown_error: "未知错误",
      importTitle: "导入备份",
      importPreview: "导入预览",
      merge: "智能合并",
      addOnly: "仅添加新数据",
      replace: "完全替换",
      confirmImport: "确认导入",
      cancel: "取消",
      importWarning: "来源角色或站点不同，请确认是否继续。",
      importSuccess: "导入完成",
      importFailed: "导入失败，现有数据没有改变。",
      invalidBackup: "备份文件格式或数据不正确。",
      confirmClear: "确定清空当前角色的全部招募记录吗？此操作不可撤销。",
      confirmDelete: "确定删除这名玩家及其全部查看和邀请记录吗？",
      waitIdentity: "等待游戏识别当前角色。首次安装后请刷新游戏页面。",
      localOnly: "数据仅保存在此浏览器",
      language: "切换语言"
    },
    en: {
      launcher: "Recruitment archive",
      sidebar: "Recruiting",
      title: "Recruitment archive",
      subtitle: "Leaderboard views and guild invitations",
      close: "Close",
      search: "Search players",
      allStatuses: "All statuses",
      allGuildStates: "All guild states",
      allCategories: "All leaderboards",
      allInviteOutcomes: "All invite outcomes",
      allTime: "All time",
      last7Days: "Last 7 days",
      last30Days: "Last 30 days",
      last90Days: "Last 90 days",
      noGuild: "No guild",
      hasGuild: "Has guild",
      invited: "Invited",
      inviteFailed: "Invite failed",
      stale: "Profile stale",
      unknown: "Unconfirmed",
      sortRecentView: "Recently viewed",
      sortRecentInvite: "Recently invited",
      sortName: "Player name",
      sortRank: "Best rank",
      exportJson: "Export full backup",
      exportCsv: "Export CSV",
      importJson: "Import backup",
      clear: "Clear this character",
      deletePlayer: "Delete this player's records",
      players: "Candidates",
      observations: "Views",
      invites: "Invites",
      timeline: "Timeline",
      emptyPlayers: "No records yet. Open a player's profile from a leaderboard.",
      emptyTimeline: "Select a player to see the complete timeline.",
      viewed: "Viewed profile",
      inviteAttempt: "Invitation submitted",
      guildNone: "No guild",
      guildUnknown: "Guild unknown",
      rank: "Rank",
      checkedAt: "Checked",
      outcome: "Result",
      pending: "Awaiting confirmation",
      sent: "Invite sent",
      already_in_guild: "Player already has a guild",
      already_invited: "Already invited",
      guild_full: "Guild is full",
      mode_mismatch: "Game mode mismatch",
      not_found: "Player not found",
      blocked: "Cannot invite this player",
      rate_limited: "Too many requests",
      timeout: "Server response timed out",
      ambiguous: "Result could not be correlated reliably",
      unknown_error: "Unknown error",
      importTitle: "Import backup",
      importPreview: "Import preview",
      merge: "Smart merge",
      addOnly: "Add new data only",
      replace: "Replace all",
      confirmImport: "Import",
      cancel: "Cancel",
      importWarning: "This backup is from another character or site. Confirm before continuing.",
      importSuccess: "Import complete",
      importFailed: "Import failed. Existing data was not changed.",
      invalidBackup: "The backup format or data is invalid.",
      confirmClear: "Clear all recruitment records for this character? This cannot be undone.",
      confirmDelete: "Delete this player and all related view and invite records?",
      waitIdentity: "Waiting for the game to identify this character. Refresh the game after first install.",
      localOnly: "Data stays in this browser",
      language: "Switch language"
    }
  };

  function detectLanguage() {
    const value = (root.document && root.document.documentElement.lang) || "";
    return value.toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  function createI18n(initialLanguage) {
    let language = initialLanguage === "zh" || initialLanguage === "en" ? initialLanguage : detectLanguage();
    return {
      get language() {
        return language;
      },
      setLanguage(next) {
        language = next === "zh" ? "zh" : "en";
      },
      t(key) {
        return messages[language][key] || messages.en[key] || key;
      }
    };
  }

  app.localization = Object.freeze({ messages, detectLanguage, createI18n });
})(globalThis);

// ---- src/bridge.js ----
(function initBridge(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});

  function pageBridgeInstaller(options) {
    "use strict";

    if (window[options.marker]) return;
    Object.defineProperty(window, options.marker, { value: true, configurable: false });

    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket !== "function") return;
    const observed = new Set(options.observedTypes);
    const officialHost = /^api(?:-test)?\.milkywayidle(?:cn)?\.com$/i;

    function isOfficial(url) {
      try {
        const parsed = new URL(String(url), location.href);
        return parsed.protocol === "wss:" && officialHost.test(parsed.hostname);
      } catch (_error) {
        return false;
      }
    }

    function asObject(value) {
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }

    function cleanVariables(value) {
      if (!Array.isArray(value)) return [];
      return value.slice(0, 20).map((entry) => ({
        name: typeof entry?.name === "string" ? entry.name : "",
        data:
          typeof entry?.data === "string" || typeof entry?.data === "number"
            ? entry.data
            : ""
      }));
    }

    function characterIdFromProfile(profile) {
      const sharable = asObject(profile.sharableCharacter);
      const direct = sharable.id ?? sharable.characterId ?? profile.characterId ?? profile.characterID;
      if (Number.isFinite(Number(direct))) return Number(direct);
      const skills = Array.isArray(profile.characterSkills)
        ? profile.characterSkills
        : Object.values(asObject(profile.characterSkills));
      const skillId = skills[0]?.characterID ?? skills[0]?.characterId;
      return Number.isFinite(Number(skillId)) ? Number(skillId) : null;
    }

    function sanitizeLeaderboardRows(rows) {
      if (!Array.isArray(rows)) return [];
      return rows.slice(0, 500).map((row) => ({
        rank: Number.isFinite(Number(row?.rank)) ? Number(row.rank) : null,
        name: typeof row?.name === "string" ? row.name : "",
        value1: row?.value1 ?? null,
        value2: row?.value2 ?? null
      }));
    }

    function sanitizeGuildCharacters(message) {
      const characterMap = asObject(message.guildCharacterMap);
      const sharableMap = asObject(message.guildSharableCharacterMap);
      const result = [];
      for (const [id, guildCharacter] of Object.entries(characterMap)) {
        const sharable = asObject(sharableMap[id]);
        result.push({
          characterId: Number.isFinite(Number(id)) ? Number(id) : null,
          name: typeof sharable.name === "string" ? sharable.name : "",
          status: typeof guildCharacter?.status === "string" ? guildCharacter.status : "",
          role: typeof guildCharacter?.role === "string" ? guildCharacter.role : "",
          joinTime: guildCharacter?.joinTime || null
        });
      }
      return result;
    }

    function sanitize(message) {
      const type = typeof message?.type === "string" ? message.type : "";
      if (!observed.has(type)) return null;
      if (type === "get_leaderboard") {
        const data = asObject(message.getLeaderboardData);
        return {
          type,
          leaderboardType: data.leaderboardType || null,
          leaderboardCategory: data.leaderboardCategory || null,
          guildTypeFilter: data.guildTypeFilter || "all",
          gameModeFilter: data.gameModeFilter || "all",
          trialFilter: data.trialFilter || "all"
        };
      }
      if (type === "leaderboard_updated") {
        const leaderboard = asObject(message.leaderboard);
        return {
          type,
          leaderboardType: leaderboard.type || message.leaderboardType || null,
          leaderboardCategory: leaderboard.category || message.leaderboardCategory || null,
          guildTypeFilter: message.guildTypeFilter || "all",
          gameModeFilter: message.gameModeFilter || "all",
          trialFilter: message.trialFilter || "all",
          leaderboardRevision: Number(message.leaderboardRevision || 0),
          rows: sanitizeLeaderboardRows(leaderboard.rows || message.rows)
        };
      }
      if (type === "view_profile") {
        return {
          type,
          characterName: message.viewProfileData?.characterName || message.characterName || ""
        };
      }
      if (type === "profile_shared") {
        const profile = asObject(message.profile || message.profileSharedData || message.profileData);
        const sharable = asObject(profile.sharableCharacter);
        return {
          type,
          profile: {
            name: sharable.name || profile.characterName || profile.name || "",
            characterId: characterIdFromProfile(profile),
            guildId: profile.guildId ?? null,
            guildName: profile.guildName ?? null,
            guildRole: profile.guildRole ?? null
          }
        };
      }
      if (type === "send_guild_invite") {
        return {
          type,
          characterName: message.sendGuildInviteData?.characterName || message.characterName || ""
        };
      }
      if (type === "info" || type === "error") {
        return {
          type,
          messageKey: message.message || message.messageKey || "",
          variables: cleanVariables(message.variables || message.messageVariables)
        };
      }
      if (type === "guild_characters_updated") {
        return {
          type,
          guildId: message.guildId ?? message.guild?.id ?? null,
          guildName: message.guildName ?? message.guild?.name ?? null,
          characters: sanitizeGuildCharacters(message)
        };
      }
      if (type === "init_character_data") {
        const characterData = asObject(message.characterData);
        const character = asObject(characterData.character || message.character);
        const guild = asObject(characterData.guild || message.guild);
        return {
          type,
          character: {
            id: character.id ?? character.characterId ?? characterData.characterId ?? null,
            name: character.name ?? characterData.characterName ?? "",
            guildId: guild.id ?? characterData.guildId ?? null,
            guildName: guild.name ?? characterData.guildName ?? null
          }
        };
      }
      return { type };
    }

    function publish(direction, raw, capturedAt) {
      if (typeof raw !== "string") return;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_error) {
        return;
      }
      const message = sanitize(parsed);
      if (!message) return;
      const at = typeof capturedAt === "string" && Number.isFinite(Date.parse(capturedAt))
        ? capturedAt
        : new Date().toISOString();
      const envelope = JSON.stringify({ direction, at, message });
      window.dispatchEvent(new CustomEvent(options.eventName, { detail: envelope }));
    }

    function observe(socket, url) {
      if (!isOfficial(url) || socket.__mwiGitObserved) return socket;
      Object.defineProperty(socket, "__mwiGitObserved", { value: true });
      const originalSend = socket.send;
      socket.send = function trackedSend(data) {
        publish("out", data);
        return originalSend.apply(this, arguments);
      };
      socket.addEventListener("message", (event) => publish("in", event.data));
      return socket;
    }

    function WrappedWebSocket(url, protocols) {
      const socket = arguments.length > 1 ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
      return observe(socket, url);
    }

    Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      Object.defineProperty(WrappedWebSocket, key, { value: NativeWebSocket[key] });
    }
    window.WebSocket = WrappedWebSocket;

    // The development loader starts before the asynchronous runtime. Adopt
    // sockets and replay relevant frames captured during that small gap.
    const developmentBridge = window.__mwiGitDevBridgeV1;
    if (developmentBridge && typeof developmentBridge === "object") {
      const sockets = Array.isArray(developmentBridge.sockets) ? [...developmentBridge.sockets] : [];
      const frames = Array.isArray(developmentBridge.frames) ? [...developmentBridge.frames] : [];
      developmentBridge.active = false;
      for (const socket of sockets) observe(socket, socket?.url);
      for (const frame of frames) publish(frame?.direction, frame?.data, frame?.at);
      developmentBridge.frames.length = 0;
      developmentBridge.sockets.length = 0;
    }
  }

  function source() {
    return `;(${pageBridgeInstaller.toString()})(${JSON.stringify({
      marker: app.config.bridgeMarker,
      eventName: app.config.bridgeEvent,
      observedTypes: app.config.observedTypes
    })});`;
  }

  function inject() {
    const code = source();
    if (typeof root.GM_addElement === "function") {
      root.GM_addElement("script", { textContent: code });
      return true;
    }
    const script = root.document.createElement("script");
    script.textContent = code;
    (root.document.documentElement || root.document.head).append(script);
    script.remove();
    return true;
  }

  app.bridge = Object.freeze({ pageBridgeInstaller, source, inject });
})(globalThis);

// ---- src/runtime/game-protocol.js ----
(function initGameProtocol(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;

  function parseEnvelope(detail) {
    let envelope = detail;
    if (typeof detail === "string") {
      try {
        envelope = JSON.parse(detail);
      } catch (_error) {
        return null;
      }
    }
    if (!envelope || (envelope.direction !== "in" && envelope.direction !== "out")) return null;
    if (!core.isIsoDate(envelope.at) || !envelope.message || typeof envelope.message.type !== "string") return null;
    return envelope;
  }

  function variableName(variables) {
    if (!Array.isArray(variables)) return "";
    const preferred = variables.find((entry) => /^(name|characterName|playerName)$/i.test(entry?.name));
    const fallback = variables.find((entry) => typeof entry?.data === "string");
    return String((preferred || fallback)?.data || "").trim();
  }

  function toDomainEvent(detail) {
    const envelope = parseEnvelope(detail);
    if (!envelope) return null;
    const { direction, at, message } = envelope;
    const type = message.type;

    if (direction === "out" && type === "get_leaderboard") {
      return {
        kind: "leaderboard_requested",
        at,
        leaderboard: {
          typeHrid: message.leaderboardType,
          categoryHrid: message.leaderboardCategory,
          filters: {
            guildType: message.guildTypeFilter || "all",
            gameMode: message.gameModeFilter || "all",
            trial: message.trialFilter || "all"
          }
        }
      };
    }
    if (direction === "in" && type === "leaderboard_updated") {
      return {
        kind: "leaderboard_snapshot",
        at,
        leaderboard: {
          typeHrid: message.leaderboardType,
          categoryHrid: message.leaderboardCategory,
          filters: {
            guildType: message.guildTypeFilter || "all",
            gameMode: message.gameModeFilter || "all",
            trial: message.trialFilter || "all"
          },
          revision: Number(message.leaderboardRevision || 0),
          capturedAt: at,
          rows: Array.isArray(message.rows)
            ? message.rows.filter((row) => row && typeof row.name === "string" && row.name.trim())
            : []
        }
      };
    }
    if (direction === "out" && type === "view_profile") {
      const name = String(message.characterName || "").trim();
      return name ? { kind: "profile_requested", at, name } : null;
    }
    if (direction === "in" && type === "profile_shared") {
      const profile = message.profile || {};
      const name = String(profile.name || "").trim();
      return name ? { kind: "profile_received", at, profile: { ...profile, name } } : null;
    }
    if (direction === "out" && type === "send_guild_invite") {
      const name = String(message.characterName || "").trim();
      return name ? { kind: "invite_attempted", at, name } : null;
    }
    if (direction === "in" && type === "info" && message.messageKey === "infoNotification.guildInviteSent") {
      return { kind: "invite_succeeded", at, name: variableName(message.variables), correlation: "info" };
    }
    if (direction === "in" && type === "error") {
      return {
        kind: "invite_failed",
        at,
        name: variableName(message.variables),
        errorKey: message.messageKey || "",
        outcome: core.outcomeFromErrorKey(message.messageKey)
      };
    }
    if (direction === "in" && type === "guild_characters_updated") {
      return {
        kind: "guild_characters",
        at,
        guildId: core.nullableNumber(message.guildId),
        guildName: typeof message.guildName === "string" ? message.guildName : null,
        characters: Array.isArray(message.characters) ? message.characters : []
      };
    }
    if (direction === "in" && type === "init_character_data") {
      const character = message.character || {};
      const id = core.nullableNumber(character.id);
      const name = String(character.name || "").trim();
      if (id === null || !name) return null;
      return {
        kind: "identity",
        at,
        identity: {
          hostname: root.location?.hostname || "unknown",
          characterId: id,
          characterName: name,
          guildId: core.nullableNumber(character.guildId),
          guildName: typeof character.guildName === "string" ? character.guildName : null
        }
      };
    }
    return null;
  }

  app.gameProtocol = Object.freeze({ parseEnvelope, variableName, toDomainEvent });
})(globalThis);

// ---- src/runtime/context-tracker.js ----
(function initContextTracker(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;

  function createContextTracker(options = {}) {
    const config = app.config;
    const randomUUID = options.randomUUID;
    let identity = options.identity || null;
    let leaderboard = null;
    const pendingProfiles = [];
    const pendingInvites = [];
    const recentProfiles = new Map();

    function prune(now) {
      const resolvedCutoff = now - Math.max(config.profileTimeoutMs, config.inviteTimeoutMs) * 4;
      for (let index = pendingProfiles.length - 1; index >= 0; index -= 1) {
        if (pendingProfiles[index].resolved && Date.parse(pendingProfiles[index].requestedAt) < resolvedCutoff) {
          pendingProfiles.splice(index, 1);
        }
      }
      for (let index = pendingInvites.length - 1; index >= 0; index -= 1) {
        if (pendingInvites[index].resolved && Date.parse(pendingInvites[index].requestedAt) < resolvedCutoff) {
          pendingInvites.splice(index, 1);
        }
      }
      for (const [key, timestamp] of recentProfiles) {
        if (timestamp < now - config.duplicateWindowMs * 4) recentProfiles.delete(key);
      }
    }

    function findRow(name) {
      if (!leaderboard) return null;
      const normalized = core.normalizeName(name);
      return leaderboard.rows.find((row) => core.normalizeName(row.name) === normalized) || null;
    }

    function leaderboardContext(name) {
      const row = findRow(name);
      if (!leaderboard || !row) return { source: "unknown", leaderboard: null };
      return {
        source: "leaderboard",
        leaderboard: {
          typeHrid: leaderboard.typeHrid,
          categoryHrid: leaderboard.categoryHrid,
          filters: core.structuredCloneSafe(leaderboard.filters),
          rank: row.rank,
          value1: row.value1 ?? null,
          value2: row.value2 ?? null,
          revision: leaderboard.revision,
          capturedAt: leaderboard.capturedAt
        }
      };
    }

    function pendingByName(list, name) {
      const normalized = core.normalizeName(name);
      return list.filter((entry) => entry.normalizedName === normalized && !entry.resolved);
    }

    function resolveInvite(entry, event, outcome, correlation, errorKey) {
      entry.resolved = true;
      entry.record = core.applyInviteOutcome(entry.record, outcome, event.at, correlation, errorKey);
      return { type: "update_invite", invite: entry.record };
    }

    function consume(event) {
      if (!event) return [];
      prune(Date.parse(event.at || 0) || Date.now());
      if (event.kind === "identity") {
        identity = event.identity;
        return [{ type: "identity", identity }];
      }
      if (event.kind === "leaderboard_snapshot") {
        leaderboard = event.leaderboard;
        return [{ type: "leaderboard", leaderboard }];
      }
      if (event.kind === "leaderboard_requested") return [];
      if (event.kind === "profile_requested") {
        pendingProfiles.push({
          name: event.name,
          normalizedName: core.normalizeName(event.name),
          requestedAt: event.at,
          context: leaderboardContext(event.name),
          resolved: false
        });
        return [];
      }
      if (event.kind === "profile_received") {
        const normalized = core.normalizeName(event.profile.name);
        const duplicateKey = `${normalized}|${JSON.stringify(event.profile)}|${leaderboard?.revision || 0}`;
        const last = recentProfiles.get(duplicateKey);
        const time = Date.parse(event.at);
        if (last && time - last < config.duplicateWindowMs) return [];
        recentProfiles.set(duplicateKey, time);
        const candidates = pendingByName(pendingProfiles, event.profile.name);
        const pending = candidates[candidates.length - 1];
        if (pending) pending.resolved = true;
        const context = pending ? pending.context : { source: "unknown", leaderboard: null };
        const observation = core.makeObservation(event.profile, context, event.at, randomUUID);
        return [{ type: "record_observation", player: core.playerFromProfile(event.profile, event.at), observation }];
      }
      if (event.kind === "invite_attempted") {
        const player = core.playerFromInvite(event.name, event.at);
        const record = core.makeInviteEvent(event.name, event.at, identity, null, randomUUID);
        pendingInvites.push({
          normalizedName: record.normalizedName,
          requestedAt: event.at,
          resolved: false,
          record
        });
        return [{ type: "record_invite", player, invite: record }];
      }
      if (event.kind === "invite_succeeded" || event.kind === "invite_failed") {
        const candidates = event.name
          ? pendingByName(pendingInvites, event.name)
          : pendingInvites.filter((entry) => !entry.resolved);
        if (candidates.length === 1) {
          const outcome = event.kind === "invite_succeeded" ? "sent" : event.outcome;
          const correlation = event.kind === "invite_succeeded" ? event.correlation : "error";
          return [resolveInvite(candidates[0], event, outcome, correlation, event.errorKey)];
        }
        if (candidates.length > 1) {
          return candidates.map((entry) => resolveInvite(entry, event, "ambiguous", "ambiguous", event.errorKey));
        }
        return [];
      }
      if (event.kind === "guild_characters") {
        const actions = [];
        if (identity) {
          identity = { ...identity, guildId: event.guildId ?? identity.guildId, guildName: event.guildName ?? identity.guildName };
          actions.push({ type: "identity", identity });
        }
        for (const character of event.characters) {
          if (character.status !== "invited" || !character.name) continue;
          const candidates = pendingByName(pendingInvites, character.name);
          if (candidates.length === 1) {
            actions.push(resolveInvite(candidates[0], event, "sent", "guild_characters_updated", null));
          } else if (candidates.length === 0) {
            actions.push({
              type: "detected_invite",
              character,
              detectedAt: event.at,
              identity
            });
          }
        }
        return actions;
      }
      return [];
    }

    function expire(now = Date.now()) {
      prune(now);
      const actions = [];
      for (const entry of pendingProfiles) {
        if (!entry.resolved && now - Date.parse(entry.requestedAt) >= config.profileTimeoutMs) {
          entry.resolved = true;
          actions.push({ type: "profile_timeout", name: entry.name, requestedAt: entry.requestedAt });
        }
      }
      for (const entry of pendingInvites) {
        if (!entry.resolved && now - Date.parse(entry.requestedAt) >= config.inviteTimeoutMs) {
          actions.push(resolveInvite(entry, { at: new Date(now).toISOString() }, "timeout", "timeout", null));
        }
      }
      return actions;
    }

    function state() {
      return {
        identity: core.structuredCloneSafe(identity),
        leaderboard: core.structuredCloneSafe(leaderboard),
        pendingProfiles: pendingProfiles.filter((entry) => !entry.resolved).length,
        pendingInvites: pendingInvites.filter((entry) => !entry.resolved).length
      };
    }

    return { consume, expire, state };
  }

  app.contextTracker = Object.freeze({ createContextTracker });
})(globalThis);

// ---- src/runtime/storage.js ----
(function initStorage(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;
  const STORE_NAMES = ["players", "profileObservations", "inviteEvents", "metadata"];

  function namespaceFor(identity) {
    if (!identity || identity.characterId == null) return null;
    return `${String(identity.hostname || "unknown").toLowerCase()}|character:${Number(identity.characterId)}`;
  }

  function dbRecord(namespace, kind, record) {
    const id = kind === "players" ? record.playerKey : record.id;
    return { ...core.structuredCloneSafe(record), pk: `${namespace}::${id}`, namespace };
  }

  function publicRecord(record) {
    if (!record) return record;
    const clone = { ...record };
    delete clone.pk;
    delete clone.namespace;
    return clone;
  }

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function transactionPromise(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    });
  }

  function openDatabase(indexedDBImpl = root.indexedDB) {
    if (!indexedDBImpl) return Promise.reject(new Error("IndexedDB is unavailable"));
    return new Promise((resolve, reject) => {
      const request = indexedDBImpl.open(app.config.databaseName, app.config.databaseVersion);
      request.onerror = () => reject(request.error || new Error("Unable to open IndexedDB"));
      request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another tab"));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("players")) {
          const players = db.createObjectStore("players", { keyPath: "pk" });
          players.createIndex("namespace", "namespace", { unique: false });
          players.createIndex("namespace_character", ["namespace", "characterId"], { unique: false });
          players.createIndex("namespace_name", ["namespace", "normalizedName"], { unique: false });
          players.createIndex("namespace_last_viewed", ["namespace", "lastViewedAt"], { unique: false });
        }
        if (!db.objectStoreNames.contains("profileObservations")) {
          const observations = db.createObjectStore("profileObservations", { keyPath: "pk" });
          observations.createIndex("namespace", "namespace", { unique: false });
          observations.createIndex("namespace_player", ["namespace", "playerKey"], { unique: false });
          observations.createIndex("namespace_viewed", ["namespace", "viewedAt"], { unique: false });
        }
        if (!db.objectStoreNames.contains("inviteEvents")) {
          const invites = db.createObjectStore("inviteEvents", { keyPath: "pk" });
          invites.createIndex("namespace", "namespace", { unique: false });
          invites.createIndex("namespace_player", ["namespace", "playerKey"], { unique: false });
          invites.createIndex("namespace_attempted", ["namespace", "attemptedAt"], { unique: false });
          invites.createIndex("namespace_outcome", ["namespace", "outcome"], { unique: false });
        }
        if (!db.objectStoreNames.contains("metadata")) {
          const metadata = db.createObjectStore("metadata", { keyPath: "pk" });
          metadata.createIndex("namespace", "namespace", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  function createRepository(options = {}) {
    let databasePromise = null;
    const indexedDBImpl = options.indexedDB || root.indexedDB;

    function database() {
      databasePromise = databasePromise || openDatabase(indexedDBImpl);
      return databasePromise;
    }

    async function getByIndex(store, index, key) {
      return requestPromise(store.index(index).get(key));
    }

    async function rewritePlayerKey(transaction, namespace, oldKey, newKey) {
      if (!oldKey || oldKey === newKey) return;
      for (const storeName of ["profileObservations", "inviteEvents"]) {
        const store = transaction.objectStore(storeName);
        const records = await requestPromise(store.index("namespace_player").getAll([namespace, oldKey]));
        for (const record of records) {
          record.playerKey = newKey;
          store.put(record);
        }
      }
    }

    async function findPlayer(transaction, namespace, player) {
      const store = transaction.objectStore("players");
      if (player.characterId != null) {
        const byId = await getByIndex(store, "namespace_character", [namespace, Number(player.characterId)]);
        if (byId) return byId;
      }
      if (player.normalizedName) {
        return getByIndex(store, "namespace_name", [namespace, player.normalizedName]);
      }
      return null;
    }

    async function recordObservation(namespace, player, observation) {
      const db = await database();
      const tx = db.transaction(["players", "profileObservations", "inviteEvents"], "readwrite");
      const done = transactionPromise(tx);
      try {
        const existing = await findPlayer(tx, namespace, player);
        const merged = core.mergePlayer(existing && publicRecord(existing), player);
        if (existing && existing.playerKey !== merged.playerKey) {
          await rewritePlayerKey(tx, namespace, existing.playerKey, merged.playerKey);
          tx.objectStore("players").delete(existing.pk);
        }
        observation.playerKey = merged.playerKey;
        tx.objectStore("players").put(dbRecord(namespace, "players", merged));
        tx.objectStore("profileObservations").put(dbRecord(namespace, "profileObservations", observation));
        await done;
        return { player: merged, observation };
      } catch (error) {
        tx.abort();
        await done.catch(() => {});
        throw error;
      }
    }

    async function recordInvite(namespace, player, invite) {
      const db = await database();
      const tx = db.transaction(["players", "inviteEvents"], "readwrite");
      const done = transactionPromise(tx);
      try {
        const existing = await findPlayer(tx, namespace, player);
        const merged = core.mergePlayer(existing && publicRecord(existing), player);
        invite.playerKey = merged.playerKey;
        merged.lastInvitedAt = core.laterIso
          ? core.laterIso(merged.lastInvitedAt, invite.attemptedAt)
          : invite.attemptedAt;
        tx.objectStore("players").put(dbRecord(namespace, "players", merged));
        tx.objectStore("inviteEvents").put(dbRecord(namespace, "inviteEvents", invite));
        await done;
        return { player: merged, invite };
      } catch (error) {
        tx.abort();
        await done.catch(() => {});
        throw error;
      }
    }

    async function updateInvite(namespace, invite) {
      const db = await database();
      const tx = db.transaction("inviteEvents", "readwrite");
      const done = transactionPromise(tx);
      const store = tx.objectStore("inviteEvents");
      const existing = await requestPromise(store.get(`${namespace}::${invite.id}`));
      const next = {
        ...invite,
        playerKey: existing?.playerKey || invite.playerKey
      };
      store.put(dbRecord(namespace, "inviteEvents", next));
      await done;
      return next;
    }

    async function snapshot(namespace) {
      const db = await database();
      const tx = db.transaction(["players", "profileObservations", "inviteEvents"], "readonly");
      const data = {};
      for (const name of ["players", "profileObservations", "inviteEvents"]) {
        const records = await requestPromise(tx.objectStore(name).index("namespace").getAll(namespace));
        data[name] = records.map(publicRecord);
      }
      await transactionPromise(tx);
      return data;
    }

    async function clearStoreNamespace(store, namespace) {
      const keys = await requestPromise(store.index("namespace").getAllKeys(namespace));
      for (const key of keys) store.delete(key);
    }

    async function replaceSnapshot(namespace, data) {
      const db = await database();
      const tx = db.transaction(["players", "profileObservations", "inviteEvents"], "readwrite");
      const done = transactionPromise(tx);
      try {
        for (const name of ["players", "profileObservations", "inviteEvents"]) {
          await clearStoreNamespace(tx.objectStore(name), namespace);
          for (const record of data[name] || []) {
            tx.objectStore(name).put(dbRecord(namespace, name, record));
          }
        }
        await done;
      } catch (error) {
        tx.abort();
        await done.catch(() => {});
        throw error;
      }
    }

    async function deletePlayer(namespace, key) {
      const current = await snapshot(namespace);
      const next = {
        players: current.players.filter((player) => player.playerKey !== key),
        profileObservations: current.profileObservations.filter((event) => event.playerKey !== key),
        inviteEvents: current.inviteEvents.filter((event) => event.playerKey !== key)
      };
      await replaceSnapshot(namespace, next);
    }

    async function clearNamespace(namespace) {
      return replaceSnapshot(namespace, { players: [], profileObservations: [], inviteEvents: [] });
    }

    async function close() {
      if (!databasePromise) return;
      const db = await databasePromise;
      db.close();
      databasePromise = null;
    }

    return {
      namespaceFor,
      recordObservation,
      recordInvite,
      updateInvite,
      snapshot,
      replaceSnapshot,
      deletePlayer,
      clearNamespace,
      close
    };
  }

  function createMemoryRepository() {
    const spaces = new Map();
    function get(namespace) {
      if (!spaces.has(namespace)) {
        spaces.set(namespace, { players: [], profileObservations: [], inviteEvents: [] });
      }
      return spaces.get(namespace);
    }
    async function snapshot(namespace) {
      return core.structuredCloneSafe(get(namespace));
    }
    async function replaceSnapshot(namespace, data) {
      spaces.set(namespace, core.structuredCloneSafe(data));
    }
    async function recordObservation(namespace, player, observation) {
      const data = get(namespace);
      const index = data.players.findIndex(
        (item) =>
          (player.characterId != null && item.characterId === player.characterId) ||
          item.normalizedName === player.normalizedName
      );
      const existing = index >= 0 ? data.players[index] : null;
      const merged = core.mergePlayer(existing, player);
      if (existing && existing.playerKey !== merged.playerKey) {
        for (const event of [...data.profileObservations, ...data.inviteEvents]) {
          if (event.playerKey === existing.playerKey) event.playerKey = merged.playerKey;
        }
      }
      if (index >= 0) data.players[index] = merged;
      else data.players.push(merged);
      observation.playerKey = merged.playerKey;
      data.profileObservations.push(core.structuredCloneSafe(observation));
      return { player: merged, observation };
    }
    async function recordInvite(namespace, player, invite) {
      const data = get(namespace);
      const index = data.players.findIndex((item) => item.normalizedName === player.normalizedName);
      const merged = core.mergePlayer(index >= 0 ? data.players[index] : null, player);
      if (index >= 0) data.players[index] = merged;
      else data.players.push(merged);
      invite.playerKey = merged.playerKey;
      data.inviteEvents.push(core.structuredCloneSafe(invite));
      return { player: merged, invite };
    }
    async function updateInvite(namespace, invite) {
      const data = get(namespace);
      const index = data.inviteEvents.findIndex((event) => event.id === invite.id);
      const next = index >= 0 ? { ...invite, playerKey: data.inviteEvents[index].playerKey } : invite;
      if (index >= 0) data.inviteEvents[index] = core.structuredCloneSafe(next);
      return next;
    }
    async function deletePlayer(namespace, key) {
      const data = get(namespace);
      data.players = data.players.filter((item) => item.playerKey !== key);
      data.profileObservations = data.profileObservations.filter((item) => item.playerKey !== key);
      data.inviteEvents = data.inviteEvents.filter((item) => item.playerKey !== key);
    }
    async function clearNamespace(namespace) {
      spaces.set(namespace, { players: [], profileObservations: [], inviteEvents: [] });
    }
    return {
      namespaceFor,
      snapshot,
      replaceSnapshot,
      recordObservation,
      recordInvite,
      updateInvite,
      deletePlayer,
      clearNamespace,
      close: async () => {}
    };
  }

  app.storage = Object.freeze({
    STORE_NAMES,
    namespaceFor,
    openDatabase,
    createRepository,
    createMemoryRepository,
    publicRecord
  });
})(globalThis);

// ---- src/runtime/import-export.js ----
(function initImportExport(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;

  function cleanFilename(value) {
    return String(value || "character")
      .normalize("NFKC")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .slice(0, 60) || "character";
  }

  function stableData(data) {
    return {
      players: [...(data.players || [])].sort((a, b) => a.playerKey.localeCompare(b.playerKey)),
      profileObservations: [...(data.profileObservations || [])].sort((a, b) => a.id.localeCompare(b.id)),
      inviteEvents: [...(data.inviteEvents || [])].sort((a, b) => a.id.localeCompare(b.id))
    };
  }

  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    if (root.crypto?.subtle) {
      const digest = await root.crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return null;
  }

  async function createBackup(data, source, exportedAt = new Date().toISOString()) {
    const normalized = stableData(data);
    const checksumValue = await sha256(JSON.stringify(normalized));
    return {
      format: app.config.appId,
      schemaVersion: app.config.schemaVersion,
      pluginVersion: app.config.version,
      exportedAt,
      source: {
        hostname: String(source?.hostname || "unknown"),
        characterId: core.nullableNumber(source?.characterId),
        characterName: String(source?.characterName || "")
      },
      counts: {
        players: normalized.players.length,
        profileObservations: normalized.profileObservations.length,
        inviteEvents: normalized.inviteEvents.length
      },
      checksum: checksumValue ? { algorithm: "SHA-256", value: checksumValue } : null,
      data: normalized
    };
  }

  function validatePlayer(player) {
    return Boolean(
      player &&
        typeof player.playerKey === "string" &&
        typeof player.currentName === "string" &&
        typeof player.normalizedName === "string" &&
        core.isIsoDate(player.firstSeenAt) &&
        core.isIsoDate(player.lastSeenAt) &&
        Array.isArray(player.nameAliases)
    );
  }

  function validateObservation(event, keys) {
    return Boolean(
      event &&
        typeof event.id === "string" &&
        keys.has(event.playerKey) &&
        typeof event.characterName === "string" &&
        core.isIsoDate(event.viewedAt) &&
        event.guildSnapshot &&
        (event.guildSnapshot.state === "joined" || event.guildSnapshot.state === "none")
    );
  }

  function validateInvite(event, keys) {
    return Boolean(
      event &&
        typeof event.id === "string" &&
        keys.has(event.playerKey) &&
        typeof event.requestedName === "string" &&
        (event.attemptedAt === null || core.isIsoDate(event.attemptedAt)) &&
        core.OUTCOMES.has(event.outcome)
    );
  }

  async function validateBackup(backup) {
    const errors = [];
    if (!backup || backup.format !== app.config.appId) errors.push("format");
    if (!Number.isInteger(backup?.schemaVersion)) errors.push("schemaVersion");
    else if (backup.schemaVersion > app.config.schemaVersion) errors.push("futureVersion");
    else if (backup.schemaVersion !== app.config.schemaVersion) errors.push("unsupportedVersion");
    if (!core.isIsoDate(backup?.exportedAt)) errors.push("exportedAt");
    if (!backup?.source || typeof backup.source.hostname !== "string") errors.push("source");
    const data = backup?.data;
    if (!data || !Array.isArray(data.players) || !Array.isArray(data.profileObservations) || !Array.isArray(data.inviteEvents)) {
      errors.push("data");
      return { valid: false, errors };
    }
    if (
      !backup.counts ||
      backup.counts.players !== data.players.length ||
      backup.counts.profileObservations !== data.profileObservations.length ||
      backup.counts.inviteEvents !== data.inviteEvents.length
    ) {
      errors.push("counts");
    }
    const playerKeys = new Set();
    const ids = new Set();
    for (const player of data.players) {
      if (!validatePlayer(player) || playerKeys.has(player.playerKey)) errors.push("player");
      playerKeys.add(player.playerKey);
    }
    for (const event of data.profileObservations) {
      if (!validateObservation(event, playerKeys) || ids.has(`observation:${event.id}`)) errors.push("observation");
      ids.add(`observation:${event.id}`);
    }
    for (const event of data.inviteEvents) {
      if (!validateInvite(event, playerKeys) || ids.has(`invite:${event.id}`)) errors.push("invite");
      ids.add(`invite:${event.id}`);
    }
    if (backup.checksum?.algorithm === "SHA-256") {
      const actual = await sha256(JSON.stringify(stableData(data)));
      if (actual && actual !== backup.checksum.value) errors.push("checksum");
    }
    return { valid: errors.length === 0, errors: [...new Set(errors)] };
  }

  async function parseBackupText(text) {
    if (new TextEncoder().encode(text).byteLength > app.config.maxImportBytes) {
      throw new Error("backup_too_large");
    }
    let backup;
    try {
      backup = JSON.parse(text);
    } catch (_error) {
      throw new Error("invalid_json");
    }
    const validation = await validateBackup(backup);
    if (!validation.valid) throw new Error(`invalid_backup:${validation.errors.join(",")}`);
    return backup;
  }

  function identityMatches(source, identity) {
    return (
      String(source?.hostname || "").toLowerCase() === String(identity?.hostname || "").toLowerCase() &&
      Number(source?.characterId) === Number(identity?.characterId)
    );
  }

  function previewImport(current, backup, identity) {
    const currentPlayerKeys = new Set(current.players.map((record) => record.playerKey));
    const currentObservationIds = new Set(current.profileObservations.map((record) => record.id));
    const currentInviteIds = new Set(current.inviteEvents.map((record) => record.id));
    return {
      source: backup.source,
      exportedAt: backup.exportedAt,
      schemaVersion: backup.schemaVersion,
      crossIdentity: !identityMatches(backup.source, identity),
      counts: backup.counts,
      duplicates: {
        players: backup.data.players.filter((record) => currentPlayerKeys.has(record.playerKey)).length,
        profileObservations: backup.data.profileObservations.filter((record) => currentObservationIds.has(record.id)).length,
        inviteEvents: backup.data.inviteEvents.filter((record) => currentInviteIds.has(record.id)).length
      }
    };
  }

  function mergeSnapshots(current, incoming, strategy = "merge") {
    if (strategy === "replace") {
      const data = core.structuredCloneSafe(stableData(incoming));
      return {
        data,
        report: {
          addedPlayers: data.players.length,
          mergedPlayers: 0,
          addedObservations: data.profileObservations.length,
          skippedObservations: 0,
          addedInvites: data.inviteEvents.length,
          skippedInvites: 0,
          replaced: true
        }
      };
    }
    const players = new Map(current.players.map((record) => [record.playerKey, core.structuredCloneSafe(record)]));
    const byCharacter = new Map(
      current.players.filter((record) => record.characterId != null).map((record) => [Number(record.characterId), record.playerKey])
    );
    const byName = new Map(current.players.map((record) => [record.normalizedName, record.playerKey]));
    const remap = new Map();
    const keyUpgrades = new Map();
    let addedPlayers = 0;
    let mergedPlayers = 0;
    for (const player of incoming.players) {
      const matchKey =
        (player.characterId != null && byCharacter.get(Number(player.characterId))) || byName.get(player.normalizedName);
      if (!matchKey) {
        players.set(player.playerKey, core.structuredCloneSafe(player));
        byName.set(player.normalizedName, player.playerKey);
        if (player.characterId != null) byCharacter.set(Number(player.characterId), player.playerKey);
        remap.set(player.playerKey, player.playerKey);
        addedPlayers += 1;
      } else {
        let resolvedKey = matchKey;
        if (strategy === "merge") {
          const merged = core.mergePlayer(players.get(matchKey), player);
          resolvedKey = merged.playerKey;
          if (resolvedKey !== matchKey) {
            players.delete(matchKey);
            keyUpgrades.set(matchKey, resolvedKey);
          }
          players.set(resolvedKey, merged);
          byName.set(merged.normalizedName, resolvedKey);
          if (merged.characterId != null) byCharacter.set(Number(merged.characterId), resolvedKey);
        }
        remap.set(player.playerKey, resolvedKey);
        mergedPlayers += 1;
      }
    }
    function mergeEvents(name) {
      const existing = new Map(
        current[name].map((record) => [
          record.id,
          { ...core.structuredCloneSafe(record), playerKey: keyUpgrades.get(record.playerKey) || record.playerKey }
        ])
      );
      let added = 0;
      let skipped = 0;
      for (const record of incoming[name]) {
        if (existing.has(record.id)) {
          skipped += 1;
          continue;
        }
        const next = { ...core.structuredCloneSafe(record), playerKey: remap.get(record.playerKey) || record.playerKey };
        existing.set(next.id, next);
        added += 1;
      }
      return { values: [...existing.values()], added, skipped };
    }
    const observations = mergeEvents("profileObservations");
    const invites = mergeEvents("inviteEvents");
    return {
      data: {
        players: [...players.values()],
        profileObservations: observations.values,
        inviteEvents: invites.values
      },
      report: {
        addedPlayers,
        mergedPlayers,
        addedObservations: observations.added,
        skippedObservations: observations.skipped,
        addedInvites: invites.added,
        skippedInvites: invites.skipped
      }
    };
  }

  function csvCell(value) {
    let text = value == null ? "" : String(value);
    if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function csv(rows) {
    return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
  }

  function createCsvExports(data) {
    const players = [
      ["playerKey", "characterId", "currentName", "aliases", "guildState", "guildName", "guildRole", "guildObservedAt", "lastViewedAt", "lastInvitedAt"],
      ...data.players.map((player) => [
        player.playerKey,
        player.characterId,
        player.currentName,
        (player.nameAliases || []).join(" | "),
        player.latestGuild?.state,
        player.latestGuild?.guildName,
        player.latestGuild?.guildRole,
        player.latestGuild?.observedAt,
        player.lastViewedAt,
        player.lastInvitedAt
      ])
    ];
    const observations = [
      ["id", "playerKey", "characterName", "viewedAt", "source", "leaderboardType", "leaderboardCategory", "rank", "value1", "value2", "guildState", "guildName", "guildRole"],
      ...data.profileObservations.map((event) => [
        event.id,
        event.playerKey,
        event.characterName,
        event.viewedAt,
        event.source,
        event.leaderboard?.typeHrid,
        event.leaderboard?.categoryHrid,
        event.leaderboard?.rank,
        event.leaderboard?.value1,
        event.leaderboard?.value2,
        event.guildSnapshot?.state,
        event.guildSnapshot?.guildName,
        event.guildSnapshot?.guildRole
      ])
    ];
    const invites = [
      ["id", "playerKey", "requestedName", "attemptedAt", "confirmedAt", "detectedAt", "outcome", "errorKey", "correlation", "hostname", "recruiterCharacterId", "guildName"],
      ...data.inviteEvents.map((event) => [
        event.id,
        event.playerKey,
        event.requestedName,
        event.attemptedAt,
        event.confirmedAt,
        event.detectedAt,
        event.outcome,
        event.errorKey,
        event.correlation,
        event.recruiter?.hostname,
        event.recruiter?.characterId,
        event.recruiter?.guildName
      ])
    ];
    return { players: csv(players), profileObservations: csv(observations), inviteEvents: csv(invites) };
  }

  function downloadText(text, filename, type = "application/json;charset=utf-8") {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = root.document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    root.document.body.append(anchor);
    anchor.click();
    anchor.remove();
    root.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function backupFilename(source, extension = "json") {
    const date = new Date().toISOString().slice(0, 10);
    return `${app.config.appId}-${cleanFilename(source?.characterName)}-${date}-v${app.config.version}.${extension}`;
  }

  app.importExport = Object.freeze({
    cleanFilename,
    stableData,
    sha256,
    createBackup,
    validateBackup,
    parseBackupText,
    identityMatches,
    previewImport,
    mergeSnapshots,
    csvCell,
    createCsvExports,
    downloadText,
    backupFilename
  });
})(globalThis);

// ---- src/runtime/scheduler.js ----
(function initScheduler(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});

  function frameScheduler(callback) {
    let frame = 0;
    let destroyed = false;
    function request() {
      if (destroyed || frame) return;
      const raf = root.requestAnimationFrame || ((fn) => root.setTimeout(fn, 16));
      frame = raf(() => {
        frame = 0;
        if (!destroyed) callback();
      });
    }
    function destroy() {
      destroyed = true;
      if (frame && root.cancelAnimationFrame) root.cancelAnimationFrame(frame);
      frame = 0;
    }
    return { request, destroy };
  }

  app.scheduler = Object.freeze({ frameScheduler });
})(globalThis);

// ---- src/ui/dom.js ----
(function initDom(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});

  function element(tag, options = {}, children = []) {
    const node = root.document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text != null) node.textContent = String(options.text);
    if (options.type) node.type = options.type;
    if (options.title) node.title = options.title;
    for (const [name, value] of Object.entries(options.attributes || {})) {
      if (value != null) node.setAttribute(name, String(value));
    }
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child) node.append(child);
    }
    return node;
  }

  function clear(node) {
    node.replaceChildren();
    return node;
  }

  function formatDate(value, language, options = {}) {
    if (!value || !Number.isFinite(Date.parse(value))) return "—";
    return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...options
    }).format(new Date(value));
  }

  function listen(node, type, handler, options) {
    node.addEventListener(type, handler, options);
    return () => node.removeEventListener(type, handler, options);
  }

  app.dom = Object.freeze({ element, clear, formatDate, listen });
})(globalThis);

// ---- src/ui/styles.js ----
(function initStyles(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const css = `
    :root {
      --mwi-git-space: #0d1420;
      --mwi-git-panel: #151f2e;
      --mwi-git-panel-2: #1b2839;
      --mwi-git-metal: #34465b;
      --mwi-git-text: #e8edf3;
      --mwi-git-muted: #97a6b8;
      --mwi-git-scan: #4cc9c0;
      --mwi-git-warning: #e5a94d;
      --mwi-git-error: #e46f61;
      --mwi-git-shield: #7299c7;
      --mwi-git-shadow: rgba(0, 0, 0, 0.46);
    }
    #mwi-git-launcher {
      position: fixed;
      right: 18px;
      bottom: 72px;
      z-index: 2147483000;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 40px;
      padding: 0 14px 0 11px;
      border: 1px solid var(--mwi-git-metal);
      border-radius: 9px;
      color: var(--mwi-git-text);
      background: linear-gradient(135deg, #162438 0%, #111b28 100%);
      box-shadow: 0 10px 30px var(--mwi-git-shadow), inset 0 1px rgba(255,255,255,.05);
      font: 600 13px/1.2 inherit;
      letter-spacing: .03em;
      cursor: pointer;
    }
    #mwi-git-launcher[hidden] { display: none; }
    #mwi-git-launcher::before {
      content: "";
      width: 9px;
      height: 9px;
      border: 1px solid var(--mwi-git-scan);
      border-radius: 50%;
      box-shadow: 0 0 0 3px rgba(76,201,192,.10), 0 0 12px rgba(76,201,192,.5);
    }
    #mwi-git-launcher:hover { border-color: var(--mwi-git-scan); }
    #mwi-git-launcher:focus-visible,
    .mwi-git-panel button:focus-visible,
    .mwi-git-panel input:focus-visible,
    .mwi-git-panel select:focus-visible,
    .mwi-git-status:focus-visible {
      outline: 2px solid var(--mwi-git-scan);
      outline-offset: 2px;
    }
    .mwi-git-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483001;
      display: grid;
      justify-items: end;
      background: rgba(5, 9, 15, .62);
      backdrop-filter: blur(3px);
    }
    .mwi-git-backdrop[hidden] { display: none; }
    .mwi-git-panel {
      width: min(980px, calc(100vw - 24px));
      height: 100%;
      color: var(--mwi-git-text);
      background:
        linear-gradient(90deg, rgba(76,201,192,.04), transparent 14%),
        var(--mwi-git-space);
      border-left: 1px solid var(--mwi-git-metal);
      box-shadow: -22px 0 60px var(--mwi-git-shadow);
      font-family: inherit;
      overflow: hidden;
      animation: mwi-git-enter 170ms ease-out;
    }
    .mwi-git-panel[hidden] { display: none; }
    [data-mwi-git-tab="true"] { user-select: none; pointer-events: auto !important; cursor: pointer !important; }
    .mwi-git-panel--native {
      position: relative;
      z-index: 0;
      box-sizing: border-box;
      flex: 1;
      width: 100%;
      min-width: 0;
      min-height: 0;
      height: 100%;
      margin: 0;
      border: 0;
      background: transparent;
      box-shadow: none;
      overflow: hidden;
      animation: none;
      container-type: inline-size;
    }
    @keyframes mwi-git-enter { from { transform: translateX(18px); opacity: .7; } }
    .mwi-git-shell { height: 100%; display: grid; grid-template-rows: auto auto auto minmax(0, 1fr); }
    .mwi-git-header {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 18px 20px 15px;
      border-bottom: 1px solid var(--mwi-git-metal);
      background: linear-gradient(180deg, rgba(52,70,91,.17), transparent);
    }
    .mwi-git-title-block { min-width: 0; flex: 1; }
    .mwi-git-title { margin: 0; font-size: 20px; line-height: 1.2; letter-spacing: .05em; }
    .mwi-git-subtitle { margin: 4px 0 0; color: var(--mwi-git-muted); font-size: 12px; }
    .mwi-git-local { display: inline-flex; align-items: center; gap: 6px; color: var(--mwi-git-muted); font-size: 11px; }
    .mwi-git-local::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--mwi-git-scan); }
    .mwi-git-icon-button,
    .mwi-git-button {
      border: 1px solid var(--mwi-git-metal);
      border-radius: 6px;
      color: var(--mwi-git-text);
      background: var(--mwi-git-panel-2);
      font: 600 12px/1 inherit;
      cursor: pointer;
    }
    .mwi-git-icon-button { width: 34px; height: 34px; font-size: 18px; }
    .mwi-git-button { min-height: 34px; padding: 0 11px; }
    .mwi-git-button:hover, .mwi-git-icon-button:hover { border-color: var(--mwi-git-scan); }
    .mwi-git-button--danger { color: #ffd7d2; border-color: rgba(228,111,97,.55); }
    .mwi-git-toolbar {
      display: grid;
      grid-template-columns: minmax(180px, 1.35fr) repeat(3, minmax(120px, .8fr));
      gap: 8px;
      padding: 12px 20px;
      border-bottom: 1px solid rgba(52,70,91,.72);
      background: var(--mwi-git-panel);
    }
    .mwi-git-input,
    .mwi-git-select {
      min-width: 0;
      height: 34px;
      padding: 0 10px;
      border: 1px solid var(--mwi-git-metal);
      border-radius: 6px;
      color: var(--mwi-git-text);
      background: #101a28;
      font: 13px/1 inherit;
    }
    .mwi-git-actions { display: flex; flex-wrap: wrap; gap: 7px; padding: 10px 20px; border-bottom: 1px solid rgba(52,70,91,.72); }
    .mwi-git-summary { margin-left: auto; display: flex; align-items: center; gap: 12px; color: var(--mwi-git-muted); font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .mwi-git-body { min-height: 0; display: grid; grid-template-columns: minmax(280px, 39%) 1fr; }
    .mwi-git-list-pane, .mwi-git-detail-pane { min-height: 0; overflow: auto; }
    .mwi-git-list-pane { border-right: 1px solid var(--mwi-git-metal); background: rgba(21,31,46,.75); }
    .mwi-git-pane-label { position: sticky; top: 0; z-index: 1; margin: 0; padding: 10px 14px; color: var(--mwi-git-muted); background: rgba(13,20,32,.96); border-bottom: 1px solid rgba(52,70,91,.7); font: 700 10px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
    .mwi-git-player {
      width: 100%;
      display: grid;
      grid-template-columns: 9px minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 12px 14px;
      border: 0;
      border-bottom: 1px solid rgba(52,70,91,.45);
      color: inherit;
      background: transparent;
      text-align: left;
      cursor: pointer;
    }
    .mwi-git-player:hover { background: rgba(76,201,192,.055); }
    .mwi-git-player[aria-selected="true"] { background: rgba(76,201,192,.11); box-shadow: inset 2px 0 var(--mwi-git-scan); }
    .mwi-git-player-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--mwi-git-muted); }
    [data-status="no_guild"] .mwi-git-player-dot { background: var(--mwi-git-scan); box-shadow: 0 0 9px rgba(76,201,192,.5); }
    [data-status="has_guild"] .mwi-git-player-dot { background: var(--mwi-git-shield); }
    [data-status="invited"] .mwi-git-player-dot { background: var(--mwi-git-warning); }
    [data-status="invite_failed"] .mwi-git-player-dot { background: var(--mwi-git-error); }
    [data-status="stale"] .mwi-git-player-dot { opacity: .42; }
    .mwi-git-player-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; font-size: 13px; }
    .mwi-git-player-meta { display: block; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--mwi-git-muted); font-size: 11px; }
    .mwi-git-player-time { color: var(--mwi-git-muted); font: 10px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .mwi-git-empty { padding: 34px 24px; color: var(--mwi-git-muted); font-size: 13px; line-height: 1.7; text-align: center; }
    .mwi-git-detail-head { display: flex; gap: 14px; align-items: center; padding: 17px 20px; border-bottom: 1px solid rgba(52,70,91,.7); }
    .mwi-git-detail-head h3 { min-width: 0; flex: 1; margin: 0; overflow: hidden; text-overflow: ellipsis; font-size: 18px; }
    .mwi-git-detail-guild { margin-top: 4px; color: var(--mwi-git-muted); font-size: 12px; }
    .mwi-git-timeline { position: relative; margin: 0; padding: 17px 20px 34px 43px; list-style: none; }
    .mwi-git-timeline::before { content: ""; position: absolute; top: 20px; bottom: 20px; left: 25px; width: 1px; background: linear-gradient(var(--mwi-git-scan), rgba(76,201,192,.12)); box-shadow: 0 0 9px rgba(76,201,192,.28); }
    .mwi-git-event { position: relative; margin: 0 0 14px; padding: 12px 14px; border: 1px solid rgba(52,70,91,.78); border-radius: 7px; background: var(--mwi-git-panel); }
    .mwi-git-event::before { content: ""; position: absolute; left: -23px; top: 16px; width: 7px; height: 7px; border: 2px solid var(--mwi-git-space); border-radius: 50%; background: var(--mwi-git-scan); box-shadow: 0 0 0 1px var(--mwi-git-scan); }
    .mwi-git-event--invite::before { background: var(--mwi-git-warning); box-shadow: 0 0 0 1px var(--mwi-git-warning); }
    .mwi-git-event-title { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; font-weight: 700; }
    .mwi-git-event-time { color: var(--mwi-git-muted); font: 10px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
    .mwi-git-event-detail { margin-top: 7px; color: var(--mwi-git-muted); font-size: 11px; line-height: 1.55; }
    .mwi-git-status { display: inline-flex; vertical-align: middle; width: 9px; height: 9px; margin-left: 6px; border: 1px solid currentColor; border-radius: 50%; color: var(--mwi-git-muted); background: transparent; cursor: help; }
    .mwi-git-status[data-status="no_guild"] { color: var(--mwi-git-scan); background: currentColor; box-shadow: 0 0 8px rgba(76,201,192,.55); }
    .mwi-git-status[data-status="has_guild"] { color: var(--mwi-git-shield); background: currentColor; border-radius: 2px 2px 5px 5px; }
    .mwi-git-status[data-status="invited"] { color: var(--mwi-git-warning); background: currentColor; }
    .mwi-git-status[data-status="invite_failed"] { color: var(--mwi-git-error); background: currentColor; }
    .mwi-git-status[data-status="stale"] { opacity: .45; border-style: dashed; }
    .mwi-git-dialog-backdrop { position: fixed; inset: 0; z-index: 2147483010; display: grid; place-items: center; padding: 18px; background: rgba(5,9,15,.76); }
    .mwi-git-dialog { width: min(520px, 100%); max-height: 85vh; overflow: auto; padding: 20px; border: 1px solid var(--mwi-git-metal); border-radius: 9px; color: var(--mwi-git-text); background: var(--mwi-git-panel); box-shadow: 0 24px 70px var(--mwi-git-shadow); }
    .mwi-git-dialog h2 { margin: 0 0 14px; font-size: 18px; }
    .mwi-git-preview { display: grid; grid-template-columns: 1fr auto; gap: 7px 14px; margin: 14px 0; padding: 12px; background: var(--mwi-git-space); border: 1px solid rgba(52,70,91,.7); border-radius: 6px; font-size: 12px; }
    .mwi-git-warning { color: #ffd99c; font-size: 12px; line-height: 1.5; }
    .mwi-git-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    .mwi-git-toast { position: fixed; right: 18px; bottom: 124px; z-index: 2147483020; max-width: min(420px, calc(100vw - 36px)); padding: 11px 14px; border: 1px solid var(--mwi-git-metal); border-radius: 7px; color: var(--mwi-git-text); background: var(--mwi-git-panel-2); box-shadow: 0 14px 36px var(--mwi-git-shadow); font-size: 12px; }
    .mwi-git-panel--native .mwi-git-header { gap: 8px; padding: 11px 10px 9px; }
    .mwi-git-panel--native .mwi-git-title { font-size: 16px; letter-spacing: .02em; }
    .mwi-git-panel--native .mwi-git-subtitle { margin-top: 2px; font-size: 10px; }
    .mwi-git-panel--native .mwi-git-icon-button { width: 30px; min-width: 30px; height: 30px; }
    .mwi-git-panel--native .mwi-git-toolbar {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      padding: 8px 10px;
    }
    .mwi-git-panel--native .mwi-git-toolbar > :first-child { grid-column: 1 / -1; }
    .mwi-git-panel--native .mwi-git-toolbar .mwi-git-local { grid-column: 1 / -1; }
    .mwi-git-panel--native .mwi-git-input,
    .mwi-git-panel--native .mwi-git-select { height: 32px; padding-inline: 8px; font-size: 11px; }
    .mwi-git-panel--native .mwi-git-actions { gap: 6px; padding: 8px 10px; }
    .mwi-git-panel--native .mwi-git-button { min-height: 32px; padding-inline: 8px; font-size: 10px; }
    .mwi-git-panel--native .mwi-git-summary { width: 100%; margin: 2px 0 0; }
    .mwi-git-panel--native .mwi-git-body {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(190px, 42%) minmax(0, 1fr);
    }
    .mwi-git-panel--native .mwi-git-list-pane { border-right: 0; border-bottom: 1px solid var(--mwi-git-metal); }
    .mwi-git-panel--native .mwi-git-player { padding: 10px; }
    .mwi-git-panel--native .mwi-git-detail-head { padding: 12px 10px; }
    .mwi-git-panel--native .mwi-git-detail-head h3 { font-size: 15px; }
    .mwi-git-panel--native .mwi-git-timeline { padding: 13px 10px 28px 35px; }
    .mwi-git-panel--native .mwi-git-timeline::before { left: 20px; }
    .mwi-git-panel--native .mwi-git-event::before { left: -19px; }
    @container (max-width: 350px) {
      .mwi-git-panel--native .mwi-git-toolbar { grid-template-columns: 1fr; }
      .mwi-git-panel--native .mwi-git-toolbar > *,
      .mwi-git-panel--native .mwi-git-toolbar > :first-child,
      .mwi-git-panel--native .mwi-git-toolbar .mwi-git-local { grid-column: 1; }
      .mwi-git-panel--native .mwi-git-local { display: none; }
      .mwi-git-panel--native .mwi-git-header { align-items: flex-start; }
      .mwi-git-panel--native .mwi-git-subtitle { display: none; }
    }
    @media (max-width: 760px) {
      .mwi-git-panel:not(.mwi-git-panel--native) { width: 100vw; }
      .mwi-git-toolbar { grid-template-columns: 1fr 1fr; }
      .mwi-git-body { grid-template-columns: 1fr; grid-template-rows: minmax(210px, 42%) minmax(0, 1fr); }
      .mwi-git-list-pane { border-right: 0; border-bottom: 1px solid var(--mwi-git-metal); }
      .mwi-git-summary { width: 100%; margin: 3px 0 0; }
      .mwi-git-actions { padding-inline: 12px; }
    }
    @media (max-width: 480px) {
      #mwi-git-launcher { right: 10px; bottom: 62px; }
      .mwi-git-header, .mwi-git-toolbar { padding-inline: 12px; }
      .mwi-git-toolbar { grid-template-columns: 1fr; }
      .mwi-git-local { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .mwi-git-panel { animation: none; }
      *, *::before, *::after { scroll-behavior: auto !important; }
    }
  `;

  function installStyles() {
    if (root.document.getElementById("mwi-git-styles")) return;
    const style = root.document.createElement("style");
    style.id = "mwi-git-styles";
    style.textContent = css;
    (root.document.head || root.document.documentElement).append(style);
  }

  app.styles = Object.freeze({ css, installStyles });
})(globalThis);

// ---- src/ui/sidebar-integration.js ----
(function initSidebarIntegration(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const SIDEBAR_LABELS = Object.freeze({
    zh: Object.freeze(["库存", "装备", "技能", "房屋", "配装", "收获"]),
    en: Object.freeze(["Inventory", "Equipment", "Skills", "House", "Loadout", "Loadouts", "Harvest", "Gathering"])
  });
  const EXPECTED_LABELS = new Set([...SIDEBAR_LABELS.zh, ...SIDEBAR_LABELS.en]);

  function normalizedLabel(element) {
    return String(element?.innerText || element?.textContent || "")
      .replaceAll("\n", "")
      .trim();
  }

  function sidebarLocale(labels) {
    const counts = { zh: 0, en: 0 };
    for (const label of Array.isArray(labels) ? labels : []) {
      if (SIDEBAR_LABELS.zh.includes(label)) counts.zh += 1;
      else if (SIDEBAR_LABELS.en.includes(label)) counts.en += 1;
    }
    if (counts.zh === counts.en) return null;
    return counts.zh > counts.en ? "zh" : "en";
  }

  function findSidebarIntegration(documentRef, preferredLanguage) {
    if (!documentRef || typeof documentRef.getElementsByTagName !== "function") return null;
    let best = null;
    for (const candidate of Array.from(documentRef.getElementsByTagName("*"))) {
      const children = Array.from(candidate.children || []);
      if (children.length < 4) continue;
      const recognized = children
        .map((element) => ({ element, label: normalizedLabel(element) }))
        .filter((tab) => EXPECTED_LABELS.has(tab.label));
      if (recognized.length < 4) continue;
      const detectedLanguage = sidebarLocale(recognized.map((tab) => tab.label));
      const prototypeLabels = (detectedLanguage || preferredLanguage) === "en"
        ? ["Inventory", "库存"]
        : ["库存", "Inventory"];
      const prototype = recognized.find((tab) => prototypeLabels.includes(tab.label)) || recognized[0];
      const tabsRoot = candidate.parentElement?.parentElement?.parentElement;
      const sidebar = tabsRoot?.parentElement;
      const panelHost = sidebar && Array.from(sidebar.children || []).find(
        (node) => node !== tabsRoot && /tabPanelsContainer/.test(String(node.className))
      );
      if (!panelHost) continue;
      const rect = typeof candidate.getBoundingClientRect === "function"
        ? candidate.getBoundingClientRect()
        : { width: 0, height: 0 };
      const visible = candidate.isConnected !== false && rect.width > 0 && rect.height > 0;
      const integration = {
        tabBar: candidate,
        tabPrototype: prototype.element,
        panelHost,
        detectedLanguage,
        score: (visible ? 1000 : 0) + recognized.length
      };
      if (!best || integration.score > best.score) best = integration;
    }
    return best;
  }

  function createController(options) {
    const panel = options.panel;
    const i18n = options.i18n;
    let integration = null;
    let tab = null;
    let hiddenNodes = [];
    let observer = null;
    let scheduled = 0;
    let fallbackTimer = 0;
    let tabBarClickHandler = null;
    let tabBarPointerHandler = null;
    let active = false;
    let destroyed = false;

    function restoreHiddenNodes() {
      for (const node of hiddenNodes) {
        if (!node.isConnected) continue;
        node.style.display = node.dataset.mwiGitPreviousDisplay || "";
        delete node.dataset.mwiGitPreviousDisplay;
      }
      hiddenNodes = [];
    }

    function hide() {
      active = false;
      panel.hideNative();
      if (tab) {
        tab.classList.remove("Mui-selected");
        tab.setAttribute("aria-selected", "false");
      }
      restoreHiddenNodes();
    }

    function show() {
      if (!integration || !tab?.isConnected || !panel.isNativeMounted()) return false;
      hide();
      hiddenNodes = Array.from(integration.panelHost.children || []).filter((node) => node !== panel.element);
      for (const node of hiddenNodes) {
        node.dataset.mwiGitPreviousDisplay = node.style.display;
        node.style.display = "none";
      }
      for (const nativeTab of Array.from(integration.tabBar.children || [])) {
        nativeTab.classList.remove("Mui-selected");
        nativeTab.setAttribute("aria-selected", "false");
      }
      tab.classList.add("Mui-selected");
      tab.setAttribute("aria-selected", "true");
      active = true;
      panel.openNative();
      return true;
    }

    function clearMount() {
      hide();
      if (integration?.tabBar && tabBarClickHandler) {
        integration.tabBar.removeEventListener("click", tabBarClickHandler);
      }
      if (integration?.tabBar && tabBarPointerHandler) {
        integration.tabBar.removeEventListener("pointerdown", tabBarPointerHandler, true);
      }
      tabBarClickHandler = null;
      tabBarPointerHandler = null;
      tab?.remove();
      tab = null;
      integration = null;
      panel.restoreOverlay();
    }

    function mountedIn(found) {
      return Boolean(
        integration &&
        tab?.isConnected &&
        tab.parentElement === found.tabBar &&
        panel.element.isConnected &&
        panel.element.parentElement === found.panelHost
      );
    }

    function ensure() {
      if (destroyed) return false;
      const found = findSidebarIntegration(root.document, i18n.language);
      if (!found) {
        if (integration && (!tab?.isConnected || !panel.isNativeMounted())) clearMount();
        return false;
      }
      if (mountedIn(found)) {
        panel.disableFallback();
        return true;
      }
      const reopen = active;
      clearMount();
      integration = found;
      tab = found.tabPrototype.cloneNode(true);
      tab.dataset.mwiGitTab = "true";
      tab.classList.remove("Mui-selected");
      tab.removeAttribute("id");
      tab.removeAttribute("disabled");
      tab.removeAttribute("aria-disabled");
      tab.setAttribute("aria-selected", "false");
      tab.setAttribute("role", "tab");
      if ("disabled" in tab) tab.disabled = false;
      tab.replaceChildren(root.document.createTextNode(i18n.t("sidebar")));
      const activate = (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        show();
      };
      tab.addEventListener("pointerdown", activate, true);
      tab.addEventListener("click", activate, true);
      found.tabBar.append(tab);
      panel.mountNative(found.panelHost, hide);
      tabBarClickHandler = (event) => {
        if (!tab || tab.parentElement !== found.tabBar || !tab.contains(event.target)) hide();
      };
      tabBarPointerHandler = (event) => {
        if (!tab || tab.parentElement !== found.tabBar || !tab.contains(event.target)) hide();
      };
      found.tabBar.addEventListener("pointerdown", tabBarPointerHandler, true);
      found.tabBar.addEventListener("click", tabBarClickHandler);
      panel.disableFallback();
      if (reopen) show();
      return true;
    }

    function scheduleEnsure() {
      if (destroyed || scheduled) return;
      scheduled = root.setTimeout(() => {
        scheduled = 0;
        if (!ensure() && !fallbackTimer) {
          fallbackTimer = root.setTimeout(() => {
            fallbackTimer = 0;
            if (!ensure()) panel.enableFallback();
          }, 1200);
        }
      }, 75);
    }

    function start() {
      if (destroyed) return false;
      const mounted = ensure();
      if (!mounted) scheduleEnsure();
      if (typeof root.MutationObserver === "function" && !observer) {
        observer = new root.MutationObserver(() => {
          if (!integration || !tab?.isConnected || !panel.isNativeMounted()) scheduleEnsure();
        });
        observer.observe(root.document.documentElement || root.document, { childList: true, subtree: true });
      }
      return mounted;
    }

    function open() {
      if (ensure()) return show();
      panel.enableFallback();
      panel.open();
      return false;
    }

    function destroy() {
      destroyed = true;
      if (scheduled) root.clearTimeout(scheduled);
      if (fallbackTimer) root.clearTimeout(fallbackTimer);
      observer?.disconnect();
      observer = null;
      clearMount();
    }

    return Object.freeze({ start, ensure, open, hide, destroy });
  }

  app.sidebarIntegration = Object.freeze({ SIDEBAR_LABELS, sidebarLocale, findSidebarIntegration, createController });
})(globalThis);

// ---- src/ui/leaderboard-decorations.js ----
(function initLeaderboardDecorations(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;

  function latestByPlayer(events, dateField) {
    const map = new Map();
    for (const event of events || []) {
      const previous = map.get(event.playerKey);
      const currentTime = Date.parse(event[dateField] || event.detectedAt || 0);
      const previousTime = Date.parse(previous?.[dateField] || previous?.detectedAt || 0);
      if (!previous || currentTime >= previousTime) map.set(event.playerKey, event);
    }
    return map;
  }

  function summaryMaps(data) {
    const byName = new Map();
    for (const player of data.players || []) {
      byName.set(core.normalizeName(player.currentName), player);
      for (const alias of player.nameAliases || []) byName.set(core.normalizeName(alias), player);
    }
    return {
      byName,
      invites: latestByPlayer(data.inviteEvents, "attemptedAt"),
      observations: latestByPlayer(data.profileObservations, "viewedAt")
    };
  }

  function titleFor(player, invite, observation, i18n) {
    const status = core.playerStatus(player, invite, Date.now(), app.config.staleProfileMs);
    const parts = [i18n.t(status === "no_guild" ? "noGuild" : status === "has_guild" ? "hasGuild" : status)];
    if (observation?.leaderboard) {
      parts.push(`${observation.leaderboard.categoryHrid || "?"} · ${i18n.t("rank")} ${observation.leaderboard.rank ?? "—"}`);
    }
    if (player.lastViewedAt) parts.push(`${i18n.t("checkedAt")} ${app.dom.formatDate(player.lastViewedAt, i18n.language)}`);
    if (invite) parts.push(`${i18n.t("outcome")}: ${i18n.t(invite.outcome)}`);
    return parts.join("\n");
  }

  function decorate(data, i18n) {
    const maps = summaryMaps(data);
    const names = root.document.querySelectorAll('[data-name="PlayerName"]');
    for (const nameNode of names) {
      const name = nameNode.textContent?.trim();
      const host = nameNode.parentElement || nameNode;
      const existing = host.querySelector(":scope > .mwi-git-status");
      const player = maps.byName.get(core.normalizeName(name));
      if (!player) {
        if (existing) existing.remove();
        continue;
      }
      const invite = maps.invites.get(player.playerKey);
      const observation = maps.observations.get(player.playerKey);
      const status = core.playerStatus(player, invite, Date.now(), app.config.staleProfileMs);
      const badge = existing || app.dom.element("span", { className: "mwi-git-status", attributes: { tabindex: "0" } });
      badge.dataset.status = status;
      badge.title = titleFor(player, invite, observation, i18n);
      badge.setAttribute("aria-label", badge.title.replace(/\n/g, ", "));
      if (!existing) host.append(badge);
    }
  }

  app.leaderboardDecorations = Object.freeze({ latestByPlayer, summaryMaps, titleFor, decorate });
})(globalThis);

// ---- src/ui/import-export-dialog.js ----
(function initImportExportDialog(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const dom = app.dom;

  function showImportDialog(preview, i18n) {
    return new Promise((resolve) => {
      const backdrop = dom.element("div", { className: "mwi-git-dialog-backdrop" });
      const dialog = dom.element("section", {
        className: "mwi-git-dialog",
        attributes: { role: "dialog", "aria-modal": "true", "aria-labelledby": "mwi-git-import-title" }
      });
      const title = dom.element("h2", { text: i18n.t("importPreview"), attributes: { id: "mwi-git-import-title" } });
      const grid = dom.element("div", { className: "mwi-git-preview" });
      const fields = [
        ["Character", `${preview.source.characterName} (#${preview.source.characterId ?? "?"})`],
        ["Site", preview.source.hostname],
        ["Exported", dom.formatDate(preview.exportedAt, i18n.language)],
        [i18n.t("players"), `${preview.counts.players} (${preview.duplicates.players} duplicate)`],
        [i18n.t("observations"), `${preview.counts.profileObservations} (${preview.duplicates.profileObservations} duplicate)`],
        [i18n.t("invites"), `${preview.counts.inviteEvents} (${preview.duplicates.inviteEvents} duplicate)`]
      ];
      for (const [label, value] of fields) {
        grid.append(dom.element("span", { text: label }), dom.element("strong", { text: value }));
      }
      const warning = preview.crossIdentity
        ? dom.element("p", { className: "mwi-git-warning", text: i18n.t("importWarning") })
        : null;
      const select = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("importTitle") } });
      for (const [value, key] of [["merge", "merge"], ["add", "addOnly"], ["replace", "replace"]]) {
        select.append(dom.element("option", { text: i18n.t(key), attributes: { value } }));
      }
      const actions = dom.element("div", { className: "mwi-git-dialog-actions" });
      const cancel = dom.element("button", { className: "mwi-git-button", text: i18n.t("cancel"), type: "button" });
      const confirm = dom.element("button", { className: "mwi-git-button", text: i18n.t("confirmImport"), type: "button" });
      function finish(value) {
        backdrop.remove();
        resolve(value);
      }
      cancel.addEventListener("click", () => finish(null));
      confirm.addEventListener("click", () => {
        if (select.value === "replace" && !root.confirm(`${i18n.t("replace")}: ${i18n.t("confirmClear")}`)) return;
        finish(select.value);
      });
      backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) finish(null);
      });
      backdrop.addEventListener("keydown", (event) => {
        if (event.key === "Escape") finish(null);
      });
      actions.append(cancel, confirm);
      dialog.append(title, grid);
      if (warning) dialog.append(warning);
      dialog.append(select, actions);
      backdrop.append(dialog);
      root.document.body.append(backdrop);
      select.focus();
    });
  }

  app.importExportDialog = Object.freeze({ showImportDialog });
})(globalThis);

// ---- src/ui/invite-history-view.js ----
(function initHistoryView(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const core = app.core;
  const dom = app.dom;

  function latestInviteMap(invites) {
    const result = new Map();
    for (const event of invites || []) {
      const previous = result.get(event.playerKey);
      const currentTime = Date.parse(event.attemptedAt || event.detectedAt || 0);
      const previousTime = Date.parse(previous?.attemptedAt || previous?.detectedAt || 0);
      if (!previous || currentTime >= previousTime) result.set(event.playerKey, event);
    }
    return result;
  }

  function guildLabel(player, i18n) {
    if (player.latestGuild?.state === "joined") {
      return [player.latestGuild.guildName, player.latestGuild.guildRole].filter(Boolean).join(" · ") || i18n.t("hasGuild");
    }
    if (player.latestGuild?.state === "none") {
      return `${i18n.t("guildNone")} · ${dom.formatDate(player.latestGuild.observedAt, i18n.language)}`;
    }
    return i18n.t("guildUnknown");
  }

  function renderPlayerList(container, data, options, selectedKey, i18n, onSelect) {
    dom.clear(container);
    const invites = latestInviteMap(data.inviteEvents);
    const players = core.filterPlayers(data.players, options, data.inviteEvents, data.profileObservations);
    if (!players.length) {
      container.append(dom.element("div", { className: "mwi-git-empty", text: i18n.t("emptyPlayers") }));
      return players;
    }
    for (const player of players) {
      const invite = invites.get(player.playerKey);
      const status = core.playerStatus(player, invite, Date.now(), app.config.staleProfileMs);
      const button = dom.element("button", {
        className: "mwi-git-player",
        type: "button",
        attributes: {
          "aria-selected": String(player.playerKey === selectedKey),
          "data-status": status
        }
      });
      const dot = dom.element("span", { className: "mwi-git-player-dot", attributes: { "aria-hidden": "true" } });
      const copy = dom.element("span");
      copy.append(
        dom.element("span", { className: "mwi-git-player-name", text: player.currentName }),
        dom.element("span", { className: "mwi-git-player-meta", text: guildLabel(player, i18n) })
      );
      const time = dom.element("span", {
        className: "mwi-git-player-time",
        text: dom.formatDate(player.lastViewedAt || player.lastInvitedAt, i18n.language, { year: undefined })
      });
      button.append(dot, copy, time);
      button.addEventListener("click", () => onSelect(player.playerKey));
      container.append(button);
    }
    return players;
  }

  function observationDetail(event, i18n) {
    const details = [];
    if (event.leaderboard) {
      details.push(`${event.leaderboard.typeHrid || "?"} / ${event.leaderboard.categoryHrid || "?"}`);
      details.push(`${i18n.t("rank")} ${event.leaderboard.rank ?? "—"}`);
    }
    const guild = event.guildSnapshot;
    details.push(guild?.state === "joined" ? [guild.guildName, guild.guildRole].filter(Boolean).join(" · ") : i18n.t("guildNone"));
    return details.filter(Boolean).join(" · ");
  }

  function renderTimeline(container, player, data, i18n, onDelete) {
    dom.clear(container);
    if (!player) {
      container.append(dom.element("div", { className: "mwi-git-empty", text: i18n.t("emptyTimeline") }));
      return;
    }
    const head = dom.element("div", { className: "mwi-git-detail-head" });
    const title = dom.element("div");
    title.append(
      dom.element("h3", { text: player.currentName }),
      dom.element("div", { className: "mwi-git-detail-guild", text: guildLabel(player, i18n) })
    );
    const remove = dom.element("button", {
      className: "mwi-git-button mwi-git-button--danger",
      text: i18n.t("deletePlayer"),
      type: "button"
    });
    remove.addEventListener("click", onDelete);
    head.append(title, remove);
    const events = [
      ...data.profileObservations
        .filter((event) => event.playerKey === player.playerKey)
        .map((event) => ({ ...event, timelineType: "observation", timelineAt: event.viewedAt })),
      ...data.inviteEvents
        .filter((event) => event.playerKey === player.playerKey)
        .map((event) => ({ ...event, timelineType: "invite", timelineAt: event.attemptedAt || event.detectedAt }))
    ].sort((a, b) => Date.parse(b.timelineAt || 0) - Date.parse(a.timelineAt || 0));
    const list = dom.element("ol", { className: "mwi-git-timeline" });
    for (const event of events) {
      const invite = event.timelineType === "invite";
      const item = dom.element("li", { className: `mwi-git-event${invite ? " mwi-git-event--invite" : ""}` });
      const eventTitle = dom.element("div", { className: "mwi-git-event-title" });
      eventTitle.append(
        dom.element("span", { text: invite ? i18n.t("inviteAttempt") : i18n.t("viewed") }),
        dom.element("time", { className: "mwi-git-event-time", text: dom.formatDate(event.timelineAt, i18n.language) })
      );
      const detail = invite
        ? `${i18n.t("outcome")}: ${i18n.t(event.outcome)}${event.errorKey ? ` · ${event.errorKey}` : ""}`
        : observationDetail(event, i18n);
      item.append(eventTitle, dom.element("div", { className: "mwi-git-event-detail", text: detail }));
      list.append(item);
    }
    if (!events.length) list.append(dom.element("li", { className: "mwi-git-empty", text: i18n.t("emptyTimeline") }));
    container.append(head, list);
  }

  app.historyView = Object.freeze({ latestInviteMap, guildLabel, renderPlayerList, renderTimeline });
})(globalThis);

// ---- src/ui/panel-shell.js ----
(function initPanelShell(root) {
  "use strict";

  const app = (root.MWIGuildInviteTracker = root.MWIGuildInviteTracker || {});
  const dom = app.dom;

  function createPanel(controller, i18n, initialView = {}) {
    let data = { players: [], profileObservations: [], inviteEvents: [] };
    let selectedKey = initialView.selectedKey || null;
    let identity = null;
    const settings = {
      query: initialView.query || "",
      guildState: initialView.guildState || "all",
      category: initialView.category || "all",
      inviteOutcome: initialView.inviteOutcome || "all",
      days: initialView.days || "all",
      sort: initialView.sort || "lastViewedAt",
      direction: initialView.direction === "asc" ? "asc" : "desc"
    };

    app.styles.installStyles();
    const launcher = dom.element("button", {
      className: "",
      text: i18n.t("launcher"),
      type: "button",
      attributes: { id: "mwi-git-launcher", "aria-haspopup": "dialog", "aria-expanded": "false", hidden: "" }
    });
    const backdrop = dom.element("div", { className: "mwi-git-backdrop", attributes: { hidden: "" } });
    const panel = dom.element("section", {
      className: "mwi-git-panel",
      attributes: { role: "dialog", "aria-modal": "true", "aria-labelledby": "mwi-git-title" }
    });
    const shell = dom.element("div", { className: "mwi-git-shell" });
    let nativeMode = false;
    let nativeHideHandler = null;

    const header = dom.element("header", { className: "mwi-git-header" });
    const titleBlock = dom.element("div", { className: "mwi-git-title-block" });
    const title = dom.element("h2", { className: "mwi-git-title", text: i18n.t("title"), attributes: { id: "mwi-git-title" } });
    const subtitle = dom.element("p", { className: "mwi-git-subtitle", text: i18n.t("subtitle") });
    titleBlock.append(title, subtitle);
    const local = dom.element("span", { className: "mwi-git-local", text: i18n.t("localOnly") });
    const language = dom.element("button", { className: "mwi-git-icon-button", text: i18n.language === "zh" ? "EN" : "中", type: "button", title: i18n.t("language") });
    const close = dom.element("button", { className: "mwi-git-icon-button", text: "×", type: "button", title: i18n.t("close"), attributes: { "aria-label": i18n.t("close") } });
    header.append(titleBlock, local, language, close);

    const toolbar = dom.element("div", { className: "mwi-git-toolbar" });
    const search = dom.element("input", { className: "mwi-git-input", type: "search", attributes: { placeholder: i18n.t("search"), "aria-label": i18n.t("search") } });
    const guildState = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("allGuildStates") } });
    for (const [value, key] of [["all", "allGuildStates"], ["none", "noGuild"], ["joined", "hasGuild"], ["unknown", "unknown"]]) {
      guildState.append(dom.element("option", { text: i18n.t(key), attributes: { value } }));
    }
    const category = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("allCategories") } });
    const inviteOutcome = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("allInviteOutcomes") } });
    inviteOutcome.append(dom.element("option", { text: i18n.t("allInviteOutcomes"), attributes: { value: "all" } }));
    for (const value of ["pending", "sent", "already_in_guild", "already_invited", "guild_full", "mode_mismatch", "not_found", "blocked", "rate_limited", "timeout", "ambiguous", "unknown_error"]) {
      inviteOutcome.append(dom.element("option", { text: i18n.t(value), attributes: { value } }));
    }
    const days = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("allTime") } });
    for (const [value, key] of [["all", "allTime"], ["7", "last7Days"], ["30", "last30Days"], ["90", "last90Days"]]) {
      days.append(dom.element("option", { text: i18n.t(key), attributes: { value } }));
    }
    const sort = dom.element("select", { className: "mwi-git-select", attributes: { "aria-label": i18n.t("sortRecentView") } });
    for (const [value, key] of [["lastViewedAt", "sortRecentView"], ["lastInvitedAt", "sortRecentInvite"], ["rank", "sortRank"], ["name", "sortName"]]) {
      sort.append(dom.element("option", { text: i18n.t(key), attributes: { value } }));
    }
    search.value = settings.query;
    guildState.value = settings.guildState;
    inviteOutcome.value = settings.inviteOutcome;
    days.value = settings.days;
    sort.value = settings.sort;
    const identityLabel = dom.element("span", { className: "mwi-git-local", text: i18n.t("waitIdentity") });
    toolbar.append(search, guildState, category, inviteOutcome, days, sort, identityLabel);

    const actions = dom.element("div", { className: "mwi-git-actions" });
    const exportJson = dom.element("button", { className: "mwi-git-button", text: i18n.t("exportJson"), type: "button" });
    const exportCsv = dom.element("button", { className: "mwi-git-button", text: i18n.t("exportCsv"), type: "button" });
    const importJson = dom.element("button", { className: "mwi-git-button", text: i18n.t("importJson"), type: "button" });
    const clear = dom.element("button", { className: "mwi-git-button mwi-git-button--danger", text: i18n.t("clear"), type: "button" });
    const file = dom.element("input", { type: "file", attributes: { accept: "application/json,.json", hidden: "" } });
    const summary = dom.element("span", { className: "mwi-git-summary" });
    actions.append(exportJson, exportCsv, importJson, clear, file, summary);

    const body = dom.element("div", { className: "mwi-git-body" });
    const listPane = dom.element("section", { className: "mwi-git-list-pane", attributes: { "aria-label": i18n.t("players") } });
    const listLabel = dom.element("h3", { className: "mwi-git-pane-label", text: i18n.t("players") });
    const list = dom.element("div");
    listPane.append(listLabel, list);
    const detailPane = dom.element("section", { className: "mwi-git-detail-pane", attributes: { "aria-label": i18n.t("timeline") } });
    body.append(listPane, detailPane);
    shell.append(header, toolbar, actions, body);
    panel.append(shell);
    backdrop.append(panel);

    function toast(message) {
      const node = dom.element("div", { className: "mwi-git-toast", text: message, attributes: { role: "status" } });
      root.document.body.append(node);
      root.setTimeout(() => node.remove(), 3500);
    }

    function selectedPlayer() {
      return data.players.find((player) => player.playerKey === selectedKey) || null;
    }

    function render() {
      const categories = [...new Set(data.profileObservations.map((event) => event.leaderboard?.categoryHrid).filter(Boolean))].sort();
      const previousCategory = settings.category;
      category.replaceChildren(dom.element("option", { text: i18n.t("allCategories"), attributes: { value: "all" } }));
      for (const value of categories) category.append(dom.element("option", { text: value.replaceAll("_", " "), attributes: { value } }));
      settings.category = categories.includes(previousCategory) ? previousCategory : "all";
      category.value = settings.category;
      const visible = app.historyView.renderPlayerList(list, data, settings, selectedKey, i18n, (key) => {
        selectedKey = key;
        render();
      });
      if (selectedKey && !data.players.some((player) => player.playerKey === selectedKey)) selectedKey = null;
      if (!selectedKey && visible.length) selectedKey = visible[0].playerKey;
      app.historyView.renderTimeline(detailPane, selectedPlayer(), data, i18n, async () => {
        if (!root.confirm(i18n.t("confirmDelete"))) return;
        await controller.deletePlayer(selectedKey);
        selectedKey = null;
        await controller.refresh();
      });
      summary.textContent = `${i18n.t("players")} ${data.players.length} · ${i18n.t("observations")} ${data.profileObservations.length} · ${i18n.t("invites")} ${data.inviteEvents.length}`;
      identityLabel.textContent = identity
        ? `${identity.characterName} · ${identity.hostname}`
        : i18n.t("waitIdentity");
    }

    function open() {
      if (nativeMode) panel.hidden = false;
      else backdrop.hidden = false;
      launcher.setAttribute("aria-expanded", "true");
      controller.refresh();
      search.focus();
    }
    function hide() {
      if (nativeMode) panel.hidden = true;
      else backdrop.hidden = true;
      launcher.setAttribute("aria-expanded", "false");
      if (!nativeMode && !launcher.hidden) launcher.focus();
    }
    function requestHide() {
      if (nativeMode && nativeHideHandler) nativeHideHandler();
      else hide();
    }
    launcher.addEventListener("click", open);
    close.addEventListener("click", requestHide);
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) requestHide(); });
    backdrop.addEventListener("keydown", (event) => { if (event.key === "Escape") requestHide(); });
    search.addEventListener("input", () => { settings.query = search.value; render(); });
    guildState.addEventListener("change", () => { settings.guildState = guildState.value; render(); });
    category.addEventListener("change", () => { settings.category = category.value; render(); });
    inviteOutcome.addEventListener("change", () => { settings.inviteOutcome = inviteOutcome.value; render(); });
    days.addEventListener("change", () => { settings.days = days.value; render(); });
    sort.addEventListener("change", () => { settings.sort = sort.value; settings.direction = sort.value === "name" || sort.value === "rank" ? "asc" : "desc"; render(); });
    exportJson.addEventListener("click", () => controller.exportJson());
    exportCsv.addEventListener("click", () => controller.exportCsv());
    importJson.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const selected = file.files?.[0];
      file.value = "";
      if (!selected) return;
      try {
        if (selected.size > app.config.maxImportBytes) throw new Error("backup_too_large");
        const prepared = await controller.prepareImport(await selected.text());
        const strategy = await app.importExportDialog.showImportDialog(prepared.preview, i18n);
        if (!strategy) return;
        const report = await controller.applyImport(prepared.backup, strategy);
        toast(`${i18n.t("importSuccess")} · +${report.addedPlayers || 0} ${i18n.t("players")}`);
        await controller.refresh();
      } catch (error) {
        console.error("[MWI Guild Invite Tracker] Import failed", error);
        toast(i18n.t("importFailed"));
      }
    });
    clear.addEventListener("click", async () => {
      if (!root.confirm(i18n.t("confirmClear"))) return;
      await controller.clear();
      selectedKey = null;
      await controller.refresh();
    });
    language.addEventListener("click", () => {
      controller.setLanguage(i18n.language === "zh" ? "en" : "zh");
    });

    function mount() {
      root.document.body.append(launcher, backdrop);
      render();
    }
    function mountNative(host, onRequestHide) {
      nativeMode = true;
      nativeHideHandler = typeof onRequestHide === "function" ? onRequestHide : null;
      launcher.hidden = true;
      backdrop.hidden = true;
      panel.hidden = true;
      panel.classList.add("mwi-git-panel--native");
      panel.setAttribute("role", "region");
      panel.removeAttribute("aria-modal");
      host.append(panel);
    }
    function restoreOverlay() {
      if (!nativeMode) return;
      nativeMode = false;
      nativeHideHandler = null;
      panel.hidden = false;
      panel.classList.remove("mwi-git-panel--native");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      backdrop.append(panel);
      backdrop.hidden = true;
    }
    function enableFallback() {
      if (!nativeMode) launcher.hidden = false;
    }
    function disableFallback() {
      launcher.hidden = true;
    }
    function setData(next) {
      data = next || { players: [], profileObservations: [], inviteEvents: [] };
      render();
    }
    function setIdentity(next) {
      identity = next;
      render();
    }
    function destroy() {
      launcher.remove();
      backdrop.remove();
      panel.remove();
    }

    function viewState() {
      return {
        ...settings,
        selectedKey,
        open: nativeMode ? !panel.hidden : !backdrop.hidden
      };
    }

    return {
      mount,
      mountNative,
      restoreOverlay,
      enableFallback,
      disableFallback,
      open,
      openNative: open,
      hide,
      hideNative: hide,
      isNativeMounted: () => nativeMode && panel.isConnected,
      element: panel,
      setData,
      setIdentity,
      render,
      toast,
      destroy,
      viewState
    };
  }

  app.panelShell = Object.freeze({ createPanel });
})(globalThis);

// ---- src/userscript.js ----
(function startUserscript(root) {
  "use strict";

  const app = root.MWIGuildInviteTracker;
  if (!app || root.__MWIGuildInviteTrackerStarted) return;
  Object.defineProperty(root, "__MWIGuildInviteTrackerStarted", { value: true });

  const repository = app.storage.createRepository();
  const tracker = app.contextTracker.createContextTracker();
  let identity = null;
  let namespace = null;
  let panel = null;
  let sidebar = null;
  let currentData = { players: [], profileObservations: [], inviteEvents: [] };
  let observer = null;
  let protocolChain = Promise.resolve();
  const queuedActions = [];
  const settings = loadSettings();
  const i18n = app.localization.createI18n(settings.language);
  const decorationScheduler = app.scheduler.frameScheduler(() => {
    app.leaderboardDecorations.decorate(currentData, i18n);
  });

  function loadSettings() {
    try {
      const value = JSON.parse(root.localStorage.getItem(app.config.settingsKey) || "{}");
      return { language: value.language === "zh" || value.language === "en" ? value.language : null };
    } catch (_error) {
      return { language: null };
    }
  }

  function saveSettings(next) {
    try {
      root.localStorage.setItem(app.config.settingsKey, JSON.stringify(next));
    } catch (_error) {
      // UI preferences are non-critical.
    }
  }

  async function refresh() {
    if (!namespace) {
      currentData = { players: [], profileObservations: [], inviteEvents: [] };
    } else {
      currentData = await repository.snapshot(namespace);
    }
    panel?.setData(currentData);
    decorationScheduler.request();
    return currentData;
  }

  async function handleDetectedInvite(action) {
    if (!namespace || !action.character?.name) return;
    const normalized = app.core.normalizeName(action.character.name);
    const exists = currentData.inviteEvents.some(
      (event) => event.normalizedName === normalized && event.outcome === "sent"
    );
    if (exists) return;
    const detectedAt = action.detectedAt;
    const player = {
      ...app.core.playerFromInvite(action.character.name, detectedAt),
      characterId: app.core.nullableNumber(action.character.characterId),
      playerKey: app.core.playerKey(action.character.characterId, action.character.name)
    };
    const invite = {
      ...app.core.makeInviteEvent(action.character.name, detectedAt, identity, null),
      id: `detected:${identity?.guildId || "guild"}:${action.character.characterId || normalized}`,
      playerKey: player.playerKey,
      attemptedAt: null,
      confirmedAt: null,
      detectedAt,
      outcome: "sent",
      correlation: "guild_characters_updated"
    };
    await repository.recordInvite(namespace, player, invite);
  }

  async function processAction(action) {
    if (action.type === "identity") {
      identity = action.identity;
      namespace = repository.namespaceFor(identity);
      panel?.setIdentity(identity);
      try {
        root.localStorage.setItem(app.config.lastIdentityKey, JSON.stringify(identity));
      } catch (_error) {
        // Identity persistence is only a diagnostic convenience.
      }
      const waiting = queuedActions.splice(0);
      for (const queued of waiting) await processAction(queued);
      await refresh();
      return;
    }
    if (action.type === "leaderboard") {
      decorationScheduler.request();
      return;
    }
    if (!namespace) {
      if (queuedActions.length < 100 && !["profile_timeout"].includes(action.type)) queuedActions.push(action);
      return;
    }
    if (action.type === "record_observation") {
      await repository.recordObservation(namespace, action.player, action.observation);
      await refresh();
      return;
    }
    if (action.type === "record_invite") {
      await repository.recordInvite(namespace, action.player, action.invite);
      await refresh();
      return;
    }
    if (action.type === "update_invite") {
      await repository.updateInvite(namespace, action.invite);
      await refresh();
      return;
    }
    if (action.type === "detected_invite") {
      await handleDetectedInvite(action);
      await refresh();
    }
  }

  function handleBridge(event) {
    const domainEvent = app.gameProtocol.toDomainEvent(event.detail);
    if (!domainEvent) return;
    const actions = tracker.consume(domainEvent);
    protocolChain = protocolChain
      .then(async () => {
        for (const action of actions) await processAction(action);
      })
      .catch((error) => console.error("[MWI Guild Invite Tracker] Failed to process game event", error));
  }

  root.addEventListener(app.config.bridgeEvent, handleBridge);
  app.bridge.inject();

  const controller = {
    refresh,
    async exportJson() {
      if (!identity || !namespace) return panel?.toast(i18n.t("waitIdentity"));
      const backup = await app.importExport.createBackup(await repository.snapshot(namespace), identity);
      app.importExport.downloadText(
        `${JSON.stringify(backup, null, 2)}\n`,
        app.importExport.backupFilename(identity)
      );
    },
    async exportCsv() {
      if (!identity || !namespace) return panel?.toast(i18n.t("waitIdentity"));
      const data = await repository.snapshot(namespace);
      const exports = app.importExport.createCsvExports(data);
      const base = app.importExport.backupFilename(identity, "csv").replace(/\.csv$/, "");
      app.importExport.downloadText(exports.players, `${base}-players.csv`, "text/csv;charset=utf-8");
      root.setTimeout(() => app.importExport.downloadText(exports.profileObservations, `${base}-profile-observations.csv`, "text/csv;charset=utf-8"), 100);
      root.setTimeout(() => app.importExport.downloadText(exports.inviteEvents, `${base}-invite-events.csv`, "text/csv;charset=utf-8"), 200);
    },
    async prepareImport(text) {
      if (!identity || !namespace) throw new Error("identity_unavailable");
      const backup = await app.importExport.parseBackupText(text);
      const preview = app.importExport.previewImport(await repository.snapshot(namespace), backup, identity);
      return { backup, preview };
    },
    async applyImport(backup, strategy) {
      if (!identity || !namespace) throw new Error("identity_unavailable");
      const current = await repository.snapshot(namespace);
      if (strategy === "replace") {
        const automaticBackup = await app.importExport.createBackup(current, identity);
        app.importExport.downloadText(
          `${JSON.stringify(automaticBackup, null, 2)}\n`,
          app.importExport.backupFilename(identity).replace(".json", "-before-replace.json")
        );
        await repository.replaceSnapshot(namespace, app.core.structuredCloneSafe(backup.data));
        return {
          addedPlayers: backup.data.players.length,
          addedObservations: backup.data.profileObservations.length,
          addedInvites: backup.data.inviteEvents.length,
          replaced: true
        };
      }
      const merged = app.importExport.mergeSnapshots(current, backup.data, strategy);
      await repository.replaceSnapshot(namespace, merged.data);
      return merged.report;
    },
    async clear() {
      if (namespace) await repository.clearNamespace(namespace);
    },
    async deletePlayer(key) {
      if (namespace && key) await repository.deletePlayer(namespace, key);
    },
    setLanguage(language) {
      saveSettings({ ...settings, language });
      const viewState = panel?.viewState() || {};
      i18n.setLanguage(language);
      sidebar?.destroy();
      sidebar = null;
      panel?.destroy();
      panel = app.panelShell.createPanel(controller, i18n, viewState);
      panel.mount();
      panel.setIdentity(identity);
      panel.setData(currentData);
      sidebar = app.sidebarIntegration.createController({ panel, i18n });
      sidebar.start();
      if (viewState.open) sidebar.open();
      decorationScheduler.request();
    }
  };

  function mount() {
    if (!root.document.body || panel) return;
    panel = app.panelShell.createPanel(controller, i18n);
    panel.mount();
    panel.setIdentity(identity);
    panel.setData(currentData);
    sidebar = app.sidebarIntegration.createController({ panel, i18n });
    sidebar.start();
    observer = new MutationObserver(() => decorationScheduler.request());
    observer.observe(root.document.body, { childList: true, subtree: true });
    decorationScheduler.request();
  }

  if (root.document.body) mount();
  else root.document.addEventListener("DOMContentLoaded", mount, { once: true });

  const expiryTimer = root.setInterval(() => {
    const actions = tracker.expire();
    protocolChain = protocolChain
      .then(async () => {
        for (const action of actions) await processAction(action);
      })
      .catch((error) => console.error("[MWI Guild Invite Tracker] Failed to expire pending events", error));
  }, 1000);

  app.runtime = Object.freeze({
    controller,
    tracker,
    repository,
    get identity() { return identity; },
    get namespace() { return namespace; },
    async destroy() {
      root.clearInterval(expiryTimer);
      root.removeEventListener(app.config.bridgeEvent, handleBridge);
      observer?.disconnect();
      decorationScheduler.destroy();
      sidebar?.destroy();
      panel?.destroy();
      await repository.close();
    }
  });
})(globalThis);
