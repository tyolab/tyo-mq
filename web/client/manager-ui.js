(function () {
  'use strict';

  var currentRequest = null;
  var settings = null;

  var els = {
    status: document.getElementById('status'),
    serverUrl: document.getElementById('server-url'),
    adminToken: document.getElementById('admin-token'),
    connectBtn: document.getElementById('connect-btn'),
    clearTokenBtn: document.getElementById('clear-token-btn'),
    mainTabBtn: document.getElementById('main-tab-btn'),
    persistenceTabBtn: document.getElementById('persistence-tab-btn'),
    observabilityTabBtn: document.getElementById('observability-tab-btn'),
    mainTab: document.getElementById('main-tab'),
    persistenceTab: document.getElementById('persistence-tab'),
    observabilityTab: document.getElementById('observability-tab'),
    refreshStatsBtn: document.getElementById('refresh-stats-btn'),
    statsOutput: document.getElementById('stats-output'),
    refreshDlqBtn: document.getElementById('refresh-dlq-btn'),
    dlqRealm: document.getElementById('dlq-realm'),
    dlqList: document.getElementById('dlq-list'),
    showSettingsBtn: document.getElementById('show-settings-btn'),
    reloadSettingsBtn: document.getElementById('reload-settings-btn'),
    refreshRealmsBtn: document.getElementById('refresh-realms-btn'),
    addRealmForm: document.getElementById('add-realm-form'),
    newRealm: document.getElementById('new-realm'),
    newRealmRequired: document.getElementById('new-realm-required'),
    newRealmEphemeral: document.getElementById('new-realm-ephemeral'),
    newRealmTtl: document.getElementById('new-realm-ttl'),
    renameRealmForm: document.getElementById('rename-realm-form'),
    renameFrom: document.getElementById('rename-from'),
    renameTo: document.getElementById('rename-to'),
    realmsList: document.getElementById('realms-list'),
    requestRealmFilter: document.getElementById('request-realm-filter'),
    requestRealmCustom: document.getElementById('request-realm-custom'),
    refreshRequestBtn: document.getElementById('refresh-request-btn'),
    nextRequestBtn: document.getElementById('next-request-btn'),
    requestCard: document.getElementById('request-card'),
    approveRole: document.getElementById('approve-role'),
    approveRequestBtn: document.getElementById('approve-request-btn'),
    rejectReason: document.getElementById('reject-reason'),
    rejectRequestBtn: document.getElementById('reject-request-btn'),
    refreshTokensBtn: document.getElementById('refresh-tokens-btn'),
    tokensList: document.getElementById('tokens-list'),
    externalAuthForm: document.getElementById('external-auth-form'),
    externalAuthUrl: document.getElementById('external-auth-url'),
    externalAuthSecret: document.getElementById('external-auth-secret'),
    disableExternalAuthBtn: document.getElementById('disable-external-auth-btn'),
    addMgmtTokenForm: document.getElementById('add-mgmt-token-form'),
    mgmtTokenPrefix: document.getElementById('mgmt-token-prefix'),
    mgmtTokenReveal: document.getElementById('mgmt-token-reveal'),
    mgmtTokensList: document.getElementById('mgmt-tokens-list'),
    settingsOutput: document.getElementById('settings-output'),
    copySettingsBtn: document.getElementById('copy-settings-btn'),
    refreshPersistenceBtn: document.getElementById('refresh-persistence-btn'),
    persistenceForm: document.getElementById('persistence-form'),
    storageBackend: document.getElementById('storage-backend'),
    storageDefaultTtl: document.getElementById('storage-default-ttl'),
    sqliteOptions: document.getElementById('sqlite-options'),
    sqliteFilename: document.getElementById('sqlite-filename'),
    redisOptions: document.getElementById('redis-options'),
    redisUrl: document.getElementById('redis-url'),
    redisPrefix: document.getElementById('redis-prefix'),
    customOptions: document.getElementById('custom-options'),
    customModule: document.getElementById('custom-module'),
    customOptionsJson: document.getElementById('custom-options-json')
  };

  function setStatus(message, isError) {
    els.status.textContent = message;
    els.status.style.color = isError ? '#b33a3a' : '#627080';
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object')
      return JSON.stringify(value);
    if (Array.isArray(value))
      return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + stableStringify(value[key]);
    }).join(',') + '}';
  }

  function bytesToHex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (value) {
      return value.toString(16).padStart(2, '0');
    }).join('');
  }

  function randomHex(bytes) {
    var values = new Uint8Array(bytes);
    window.crypto.getRandomValues(values);
    return bytesToHex(values);
  }

  function localRealmKeyStore() {
    var serverUrl = els.serverUrl.value.trim() || 'default';
    return 'tyoMqManagerRealmKeys:' + serverUrl;
  }

  function loadLocalRealmKeys() {
    try {
      return JSON.parse(window.localStorage.getItem(localRealmKeyStore()) || '{}') || {};
    }
    catch (err) {
      return {};
    }
  }

  function getLocalRealmManagerKey(realm) {
    return loadLocalRealmKeys()[realm] || '';
  }

  function saveLocalRealmManagerKey(realm, managerKey) {
    var keys = loadLocalRealmKeys();
    if (managerKey)
      keys[realm] = managerKey;
    else
      delete keys[realm];
    window.localStorage.setItem(localRealmKeyStore(), JSON.stringify(keys));
  }

  function localRealmPskStore() {
    var serverUrl = els.serverUrl.value.trim() || 'default';
    return 'tyoMqManagerRealmPsks:' + serverUrl;
  }

  function loadLocalRealmPsks() {
    try {
      return JSON.parse(window.localStorage.getItem(localRealmPskStore()) || '{}') || {};
    }
    catch (err) {
      return {};
    }
  }

  function getLocalRealmPsk(realm) {
    return loadLocalRealmPsks()[realm] || '';
  }

  function saveLocalRealmPsk(realm, key) {
    var keys = loadLocalRealmPsks();
    if (key)
      keys[realm] = key;
    else
      delete keys[realm];
    window.localStorage.setItem(localRealmPskStore(), JSON.stringify(keys));
  }

  async function copyText(value) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }

    var input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', 'readonly');
    input.style.position = 'fixed';
    input.style.left = '-1000px';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
  }

  function signatureBase(action, body, timestamp, nonce) {
    return [
      String(action || ''),
      String(timestamp || ''),
      String(nonce || ''),
      stableStringify(body || {})
    ].join('\n');
  }

  async function createAdminProof(adminToken, action, body) {
    if (!window.crypto || !window.crypto.subtle)
      throw new Error('Browser signing requires HTTPS or localhost');

    var timestamp = Date.now();
    var nonce = randomHex(16);
    var encoder = new TextEncoder();
    var key = await window.crypto.subtle.importKey(
      'raw',
      encoder.encode(String(adminToken)),
      {name: 'HMAC', hash: 'SHA-256'},
      false,
      ['sign']
    );
    var signature = await window.crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(signatureBase(action, body || {}, timestamp, nonce))
    );
    return {
      timestamp: timestamp,
      nonce: nonce,
      signature: bytesToHex(signature)
    };
  }

  function parseServerUrl(raw) {
    var parsed = new URL(raw);
    return {
      host: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      protocol: parsed.protocol.replace(':', '')
    };
  }

  function connectSocket() {
    return new Promise(function (resolve, reject) {
      var target;
      var serverUrl = els.serverUrl.value.trim();
      if (!serverUrl) {
        reject(new Error('Server URL is required'));
        return;
      }

      try {
        target = parseServerUrl(serverUrl);
      }
      catch (err) {
        reject(new Error('Invalid server URL'));
        return;
      }

      var factory = new window.mq.Factory({
        logger: {
          log: function () {},
          warn: console.warn.bind(console),
          error: console.error.bind(console)
        }
      });
      var socket = factory.createSocket(function (connectedSocket, err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(connectedSocket || socket);
      }, target.port, target.host, target.protocol, {transports: ['websocket']});
    });
  }

  function emitAck(socket, event, payload) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('Timed out waiting for ' + event));
      }, 10000);

      socket.socket.emit(event, payload, function (response) {
        clearTimeout(timer);
        if (!response || response.ok === false) {
          var err = new Error((response && response.message) || (event + ' failed'));
          err.response = response;
          reject(err);
          return;
        }
        resolve(response);
      });
    });
  }

  async function signedCommand(event, body) {
    var adminToken = els.adminToken.value;
    if (!adminToken)
      throw new Error('Admin token is required');

    var socket = await connectSocket();
    try {
      var proof = await createAdminProof(adminToken, event, body || {});
      return await emitAck(socket, event, {body: body || {}, proof: proof});
    }
    finally {
      socket.disconnect();
    }
  }

  function managementCommand(body) {
    return signedCommand('AUTH_MANAGEMENT_COMMAND', body);
  }

  function nextAuthorizationRequest(filter) {
    return signedCommand('AUTHORIZATION_NEXT', filter || {});
  }

  function decideAuthorizationRequest(decision) {
    return signedCommand('AUTHORIZATION_DECIDE', decision || {});
  }

  function setSettings(next) {
    settings = next || {};
    els.settingsOutput.textContent = JSON.stringify(settings, null, 2);
    renderRealms();
    renderTokens();
    renderExternalAuth();
    renderManagementTokens();
    renderPersistence();
  }

  function renderManagementTokens() {
    var entries = (settings && settings.management_tokens) || [];
    els.mgmtTokensList.innerHTML = '';

    if (entries.length === 0) {
      els.mgmtTokensList.className = 'list empty';
      els.mgmtTokensList.textContent = 'No management tokens configured';
      return;
    }

    els.mgmtTokensList.className = 'list';
    entries.forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'token-row';

      var detail = document.createElement('div');
      detail.className = 'token-detail';

      var title = document.createElement('div');
      title.className = 'token-title';
      title.textContent = entry.realm_prefix || '(no prefix)';

      var meta = document.createElement('div');
      meta.className = 'token-meta';
      meta.textContent = entry.token_hash
        ? 'sha256 ' + entry.token_hash.slice(0, 16) + '…'
        : 'no token';

      detail.appendChild(title);
      detail.appendChild(meta);

      var revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'danger';
      revoke.textContent = 'Revoke';
      revoke.disabled = !entry.token_hash;
      revoke.addEventListener('click', function () {
        handle(async function () {
          var confirmed = window.confirm(
            'Revoke the management token for prefix "' + (entry.realm_prefix || '?') + '"?\n\n' +
            'HTTP API callers using it (e.g. tyoman-server realm registration) will get 401s.');
          if (!confirmed)
            return;
          var response = await managementCommand({
            command: 'revoke_management_token',
            token_hash: entry.token_hash
          });
          setSettings(response.settings);
          setStatus('Management token revoked');
        });
      });

      row.appendChild(detail);
      row.appendChild(revoke);
      els.mgmtTokensList.appendChild(row);
    });
  }

  function renderExternalAuth() {
    els.externalAuthUrl.value = (settings && settings.auth_url) || '';
    // The secret is never echoed back (the server masks it); a blank input
    // means "keep the current one".
    els.externalAuthSecret.value = '';
    els.externalAuthSecret.placeholder = (settings && settings.auth_secret)
      ? 'configured — leave blank to keep'
      : 'not set';
  }

  function setActiveTab(name) {
    var tabs = {
      main: [els.mainTabBtn, els.mainTab],
      persistence: [els.persistenceTabBtn, els.persistenceTab],
      observability: [els.observabilityTabBtn, els.observabilityTab]
    };
    if (!tabs[name])
      name = 'main';
    Object.keys(tabs).forEach(function (key) {
      tabs[key][0].classList.toggle('active', key === name);
      tabs[key][1].classList.toggle('active', key === name);
    });
    window.localStorage.setItem('tyoMqManagerActiveTab', name);
  }

  function renderRealms() {
    var realms = (settings && settings.realms) || {};
    var names = Object.keys(realms).sort();
    els.realmsList.innerHTML = '';
    renderRealmFilter(names);

    if (names.length === 0) {
      els.realmsList.className = 'list empty';
      els.realmsList.textContent = 'No realms configured';
      return;
    }

    els.realmsList.className = 'list';
    names.forEach(function (name) {
      var realm = realms[name] || {};
      var required = !!realm.required;
      var managerKeyConfigured = !!realm.manager_key_configured;
      var localManagerKey = getLocalRealmManagerKey(name);
      var row = document.createElement('div');
      row.className = 'realm-row';

      var detail = document.createElement('div');
      detail.className = 'realm-detail';

      var label = document.createElement('div');
      label.className = 'realm-name';
      label.textContent = name;

      var meta = document.createElement('div');
      meta.className = 'realm-meta';
      meta.textContent = managerKeyConfigured
        ? (localManagerKey ? 'manager key available locally' : 'manager key configured')
        : 'no manager key';

      detail.appendChild(label);
      detail.appendChild(meta);

      var pill = document.createElement('span');
      pill.className = required ? 'pill' : 'pill open';
      pill.textContent = required ? 'auth required' : 'open';

      var lifetimePill = null;
      if (realm.ephemeral || realm.temporary) {
        lifetimePill = document.createElement('span');
        lifetimePill.className = 'pill open';
        lifetimePill.textContent = 'ephemeral';
        if (realm.expires_at) {
          lifetimePill.title = 'Disposed automatically at ' + new Date(realm.expires_at).toLocaleString();
          lifetimePill.textContent = 'ephemeral · expires ' + new Date(realm.expires_at).toLocaleString();
        }
      }

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'secondary';
      toggle.textContent = required ? 'Disable auth' : 'Require auth';
      toggle.addEventListener('click', function () {
        handle(function () {
          return setRealmAuth(name, !required);
        });
      });

      var generate = document.createElement('button');
      generate.type = 'button';
      generate.textContent = managerKeyConfigured ? 'Rotate key' : 'Generate key';
      generate.addEventListener('click', function () {
        handle(function () {
          return generateRealmManagerKey(name);
        });
      });

      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'secondary';
      copy.textContent = 'Copy key';
      copy.disabled = !localManagerKey;
      copy.addEventListener('click', function () {
        handle(function () {
          return copyRealmManagerKey(name);
        });
      });

      var clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'secondary';
      clear.textContent = 'Clear key';
      clear.disabled = !managerKeyConfigured;
      clear.addEventListener('click', function () {
        handle(function () {
          return clearRealmManagerKey(name);
        });
      });

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger';
      remove.textContent = 'Remove realm';
      // Structural realms are never removable.
      remove.disabled = (name === 'default' || name === '*');
      remove.addEventListener('click', function () {
        var typed = window.prompt(
          'This permanently removes realm "' + name + '" and any tokens scoped to it.\n\n' +
          'Type the realm name to confirm:');
        if (typed === null)
          return; // cancelled
        if (typed.trim() !== name) {
          setStatus('Realm name did not match — removal cancelled', true);
          return;
        }
        handle(function () {
          return removeRealm(name);
        });
      });

      row.appendChild(detail);
      row.appendChild(pill);
      if (lifetimePill)
        row.appendChild(lifetimePill);
      row.appendChild(toggle);
      row.appendChild(generate);
      row.appendChild(copy);
      row.appendChild(clear);
      row.appendChild(remove);
      els.realmsList.appendChild(row);

      // Connection access: consumer pre-shared key + producer acceptance.
      var keyConfigured = !!realm.key_configured;
      var localPsk = getLocalRealmPsk(name);
      var acceptanceRequired = realm.require_acceptance !== false;

      var accessRow = document.createElement('div');
      accessRow.className = 'realm-row';

      var accessDetail = document.createElement('div');
      accessDetail.className = 'realm-detail';

      var accessLabel = document.createElement('div');
      accessLabel.className = 'realm-name';
      accessLabel.textContent = name + ' · connections';

      var accessMeta = document.createElement('div');
      accessMeta.className = 'realm-meta';
      accessMeta.textContent = (keyConfigured
        ? (localPsk ? 'consumer key available locally' : 'consumer key configured')
        : 'consumers connect without a key')
        + ' · producers ' + (acceptanceRequired ? 'need acceptance' : 'auto-accepted');

      accessDetail.appendChild(accessLabel);
      accessDetail.appendChild(accessMeta);

      var acceptancePill = document.createElement('span');
      acceptancePill.className = acceptanceRequired ? 'pill' : 'pill open';
      acceptancePill.textContent = acceptanceRequired ? 'acceptance required' : 'producers open';

      var acceptanceToggle = document.createElement('button');
      acceptanceToggle.type = 'button';
      acceptanceToggle.className = 'secondary';
      acceptanceToggle.textContent = acceptanceRequired ? 'Waive acceptance' : 'Require acceptance';
      acceptanceToggle.addEventListener('click', function () {
        handle(function () {
          return setRealmAcceptance(name, !acceptanceRequired);
        });
      });

      var generatePsk = document.createElement('button');
      generatePsk.type = 'button';
      generatePsk.textContent = keyConfigured ? 'Rotate consumer key' : 'Generate consumer key';
      generatePsk.addEventListener('click', function () {
        handle(function () {
          return generateRealmKey(name);
        });
      });

      var copyPsk = document.createElement('button');
      copyPsk.type = 'button';
      copyPsk.className = 'secondary';
      copyPsk.textContent = 'Copy consumer key';
      copyPsk.disabled = !localPsk;
      copyPsk.addEventListener('click', function () {
        handle(function () {
          return copyRealmKey(name);
        });
      });

      var clearPsk = document.createElement('button');
      clearPsk.type = 'button';
      clearPsk.className = 'secondary';
      clearPsk.textContent = 'Clear consumer key';
      clearPsk.disabled = !keyConfigured;
      clearPsk.addEventListener('click', function () {
        handle(function () {
          return clearRealmKey(name);
        });
      });

      accessRow.appendChild(accessDetail);
      accessRow.appendChild(acceptancePill);
      accessRow.appendChild(acceptanceToggle);
      accessRow.appendChild(generatePsk);
      accessRow.appendChild(copyPsk);
      accessRow.appendChild(clearPsk);
      els.realmsList.appendChild(accessRow);
    });
  }

  function getRequestRealmFilter() {
    if (els.requestRealmFilter.value === '__custom')
      return els.requestRealmCustom.value.trim();
    return els.requestRealmFilter.value.trim();
  }

  function renderRealmFilter(names) {
    var saved = window.localStorage.getItem('tyoMqManagerRealmFilter') || '';
    var current = getRequestRealmFilter() || saved;
    els.requestRealmFilter.innerHTML = '';

    var any = document.createElement('option');
    any.value = '';
    any.textContent = 'Any realm';
    els.requestRealmFilter.appendChild(any);

    names.forEach(function (name) {
      var option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      els.requestRealmFilter.appendChild(option);
    });

    var custom = document.createElement('option');
    custom.value = '__custom';
    custom.textContent = 'Custom realm...';
    els.requestRealmFilter.appendChild(custom);

    if (!current) {
      els.requestRealmFilter.value = '';
      els.requestRealmCustom.classList.remove('visible');
      els.requestRealmCustom.value = '';
    }
    else if (names.indexOf(current) >= 0) {
      els.requestRealmFilter.value = current;
      els.requestRealmCustom.classList.remove('visible');
      els.requestRealmCustom.value = '';
    }
    else {
      els.requestRealmFilter.value = '__custom';
      els.requestRealmCustom.classList.add('visible');
      els.requestRealmCustom.value = current;
    }
  }

  function renderRequest(request) {
    currentRequest = request || null;
    els.requestCard.innerHTML = '';

    if (!request) {
      els.requestCard.className = 'request-card empty';
      els.requestCard.textContent = 'No pending request loaded';
      return;
    }

    els.requestCard.className = 'request-card';
    var dl = document.createElement('dl');
    [
      ['Request ID', request.request_id],
      ['Status', request.status],
      ['Realm', request.realm],
      ['Role', request.role],
      ['Client ID', request.client_id],
      ['Client name', request.client_name],
      ['Token hash', request.client_token_hash],
      ['Created', request.created_at],
      ['Challenge', request.challenge_response ? JSON.stringify(request.challenge_response) : '']
    ].forEach(function (pair) {
      var dt = document.createElement('dt');
      var dd = document.createElement('dd');
      dt.textContent = pair[0];
      dd.textContent = pair[1] || '';
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    els.requestCard.appendChild(dl);
  }

  function renderTokens() {
    var tokens = (settings && settings.tokens) || [];
    els.tokensList.innerHTML = '';

    if (tokens.length === 0) {
      els.tokensList.className = 'list empty';
      els.tokensList.textContent = 'No authorized clients configured';
      return;
    }

    els.tokensList.className = 'list';
    tokens.forEach(function (token) {
      var row = document.createElement('div');
      row.className = 'token-row';

      var detail = document.createElement('div');
      detail.className = 'token-detail';

      var title = document.createElement('div');
      title.className = 'token-title';
      title.textContent = token.client_name || token.client_id || token.realm || 'Token';

      var meta = document.createElement('div');
      meta.className = 'token-meta';
      meta.textContent = [
        token.realm || 'realm?',
        token.role || 'role?',
        token.client_id || 'no client id'
      ].join(' / ');

      detail.appendChild(title);
      detail.appendChild(meta);

      var revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'danger';
      revoke.textContent = 'Revoke';
      revoke.disabled = !token.token_hash || (token.realm === '*' && token.role === 'admin');
      revoke.addEventListener('click', function () {
        revokeToken(token);
      });

      row.appendChild(detail);
      row.appendChild(revoke);
      els.tokensList.appendChild(row);
    });
  }

  function renderBackendOptions() {
    var backend = els.storageBackend.value;
    els.sqliteOptions.classList.toggle('visible', backend === 'sqlite');
    els.redisOptions.classList.toggle('visible', backend === 'redis');
    els.customOptions.classList.toggle('visible', backend === 'custom');
  }

  function renderPersistence() {
    var persistence = (settings && settings.persistence) || {};
    var storage = persistence.storage || 'memory';
    var options = persistence.storage_options || {};

    els.storageBackend.value = storage;
    if (els.storageBackend.value !== storage)
      els.storageBackend.value = 'memory';

    els.storageDefaultTtl.value = options.default_ttl !== undefined ? options.default_ttl : '';
    els.sqliteFilename.value = options.filename || options.path || '';
    els.redisUrl.value = options.url || '';
    els.redisPrefix.value = options.prefix || '';
    els.customModule.value = options.module || options.module_path || '';

    var customOptions = {};
    Object.keys(options).forEach(function (key) {
      if (['default_ttl', 'defaultTtl', 'module', 'module_path'].indexOf(key) < 0)
        customOptions[key] = options[key];
    });
    els.customOptionsJson.value = Object.keys(customOptions).length ? JSON.stringify(customOptions, null, 2) : '';
    renderBackendOptions();
  }

  function buildPersistenceCommand() {
    var backend = els.storageBackend.value;
    var options = {};
    var ttl = els.storageDefaultTtl.value.trim();

    if (ttl) {
      options.default_ttl = Number(ttl);
      if (!Number.isFinite(options.default_ttl))
        throw new Error('Default TTL must be a number');
    }

    if (backend === 'sqlite') {
      var filename = els.sqliteFilename.value.trim();
      if (filename)
        options.filename = filename;
    }
    else if (backend === 'redis') {
      var url = els.redisUrl.value.trim();
      var prefix = els.redisPrefix.value.trim();
      if (url)
        options.url = url;
      if (prefix)
        options.prefix = prefix;
    }
    else if (backend === 'custom') {
      var modulePath = els.customModule.value.trim();
      if (!modulePath)
        throw new Error('Custom store module path is required');

      var raw = els.customOptionsJson.value.trim();
      if (raw) {
        try {
          Object.assign(options, JSON.parse(raw));
        }
        catch (err) {
          throw new Error('Custom storage_options JSON is invalid');
        }
      }
      options.module = modulePath;
    }

    return {
      command: 'set_persistence',
      storage: backend,
      storage_options: options
    };
  }

  async function refreshSettings() {
    var response = await managementCommand({command: 'get'});
    setSettings(response.settings);
    setStatus('Auth settings loaded');
  }

  async function reloadSettingsFromDisk() {
    var response = await managementCommand({command: 'reload_settings'});
    setSettings(response.settings);
    setStatus('Server reloaded settings from disk');
  }

  async function connectManager() {
    els.connectBtn.disabled = true;
    try {
      await refreshSettings();
      setStatus('Connected. Admin signature accepted.');
    }
    finally {
      els.connectBtn.disabled = false;
    }
  }

  async function setRealmAuth(realm, required) {
    var response = await managementCommand({
      command: 'set_realm_auth',
      realm: realm,
      required: required
    });
    setSettings(response.settings);
    setStatus('Updated realm ' + realm);
  }

  async function removeRealm(realm) {
    var response = await managementCommand({
      command: 'remove_realm',
      realm: realm
    });
    saveLocalRealmManagerKey(realm, '');
    saveLocalRealmPsk(realm, '');
    setSettings(response.settings);
    var removed = response.removed_tokens ? (' (' + response.removed_tokens + ' token(s) removed)') : '';
    setStatus('Removed realm ' + realm + removed);
  }

  async function setRealmManagerKey(realm, managerKey) {
    var response = await managementCommand({
      command: 'set_realm_manager_key',
      realm: realm,
      manager_key: managerKey || null
    });
    if (managerKey)
      saveLocalRealmManagerKey(realm, managerKey);
    else
      saveLocalRealmManagerKey(realm, '');
    setSettings(response.settings);
    return response;
  }

  async function generateRealmManagerKey(realm) {
    var configured = !!(settings && settings.realms && settings.realms[realm]
      && settings.realms[realm].manager_key_configured);
    if (configured && !window.confirm('Rotate manager key for ' + realm + '? Existing operators using the old key will stop working.'))
      return;

    var managerKey = randomHex(32);
    await setRealmManagerKey(realm, managerKey);
    await copyText(managerKey);
    setStatus('Generated and copied manager key for ' + realm);
  }

  async function copyRealmManagerKey(realm) {
    var managerKey = getLocalRealmManagerKey(realm);
    if (!managerKey)
      throw new Error('Manager key is not available locally. Generate a new one to copy it.');
    await copyText(managerKey);
    setStatus('Manager key copied for ' + realm);
  }

  async function clearRealmManagerKey(realm) {
    if (!window.confirm('Clear manager key for ' + realm + '? Realm operators will no longer be able to approve requests with that key.'))
      return;
    await setRealmManagerKey(realm, null);
    setStatus('Cleared manager key for ' + realm);
  }

  async function setRealmKey(realm, key) {
    var response = await managementCommand({
      command: 'set_realm_key',
      realm: realm,
      key: key || null
    });
    saveLocalRealmPsk(realm, key || '');
    setSettings(response.settings);
    return response;
  }

  async function generateRealmKey(realm) {
    var configured = !!(settings && settings.realms && settings.realms[realm]
      && settings.realms[realm].key_configured);
    if (configured && !window.confirm('Rotate pre-shared key for ' + realm + '? Consumers using the old key will stop connecting.'))
      return;

    var key = randomHex(32);
    await setRealmKey(realm, key);
    await copyText(key);
    setStatus('Generated and copied pre-shared key for ' + realm);
  }

  async function copyRealmKey(realm) {
    var key = getLocalRealmPsk(realm);
    if (!key)
      throw new Error('Pre-shared key is not available locally. Generate a new one to copy it.');
    await copyText(key);
    setStatus('Pre-shared key copied for ' + realm);
  }

  async function clearRealmKey(realm) {
    if (!window.confirm('Clear pre-shared key for ' + realm + '? Consumers will connect without a key.'))
      return;
    await setRealmKey(realm, null);
    setStatus('Cleared pre-shared key for ' + realm);
  }

  async function setRealmAcceptance(realm, required) {
    var response = await managementCommand({
      command: 'set_realm_acceptance',
      realm: realm,
      required: required
    });
    setSettings(response.settings);
    setStatus('Realm ' + realm + ' producer acceptance ' + (required ? 'required' : 'waived'));
  }

  async function revokeToken(token) {
    if (!token || !token.token_hash)
      throw new Error('Token hash is required');

    var label = token.client_name || token.client_id || token.token_hash.slice(0, 12);
    if (!window.confirm('Revoke token for ' + label + '?'))
      return;

    var response = await managementCommand({
      command: 'revoke_token',
      token_hash: token.token_hash
    });
    setSettings(response.settings);
    setStatus('Revoked token for ' + label);
  }

  async function refreshStats() {
    var response = await managementCommand({command: 'stats'});
    els.statsOutput.textContent = JSON.stringify(response.stats, null, 2);
    setStatus('Live stats loaded');
  }

  function renderDlqEntries(entries) {
    els.dlqList.innerHTML = '';
    if (!entries || entries.length === 0) {
      els.dlqList.className = 'list empty';
      els.dlqList.textContent = 'Dead-letter queue is empty';
      return;
    }

    els.dlqList.className = 'list';
    entries.forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'realm-row';

      var detail = document.createElement('div');
      detail.className = 'realm-detail';

      var label = document.createElement('div');
      label.className = 'realm-name';
      label.textContent = entry.realm + ' · ' + entry.event;

      var meta = document.createElement('div');
      meta.className = 'realm-meta';
      meta.textContent = 'consumer ' + entry.consumer + ' · ' + (entry.reason || 'no reason')
        + ' · ' + (entry.dead_lettered_at || '') + ' · ' + entry.id;

      detail.appendChild(label);
      detail.appendChild(meta);

      var replay = document.createElement('button');
      replay.type = 'button';
      replay.textContent = 'Replay';
      replay.addEventListener('click', function () {
        handle(async function () {
          await managementCommand({command: 'dlq_replay', realm: entry.realm, msg_id: entry.id});
          setStatus('Replayed ' + entry.id);
          await refreshDlq();
        });
      });

      var discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'secondary';
      discard.textContent = 'Discard';
      discard.addEventListener('click', function () {
        handle(async function () {
          if (!window.confirm('Discard dead-letter message ' + entry.id + '?'))
            return;
          await managementCommand({command: 'dlq_discard', realm: entry.realm, msg_id: entry.id});
          setStatus('Discarded ' + entry.id);
          await refreshDlq();
        });
      });

      row.appendChild(detail);
      row.appendChild(replay);
      row.appendChild(discard);
      els.dlqList.appendChild(row);
    });
  }

  async function refreshDlq() {
    var realm = els.dlqRealm.value.trim();
    var response = await managementCommand({command: 'dlq_list', realm: realm || null});
    renderDlqEntries(response.entries);
    setStatus('Dead-letter queue loaded (' + (response.entries || []).length + ' entries)');
  }

  async function handle(action) {
    try {
      await action();
    }
    catch (err) {
      console.error(err);
      setStatus(err.message, true);
      if (err.response)
        els.settingsOutput.textContent = JSON.stringify(err.response, null, 2);
    }
  }

  els.connectBtn.addEventListener('click', function () {
    handle(connectManager);
  });

  els.showSettingsBtn.addEventListener('click', function () {
    handle(refreshSettings);
  });

  els.reloadSettingsBtn.addEventListener('click', function () {
    handle(reloadSettingsFromDisk);
  });

  els.mainTabBtn.addEventListener('click', function () {
    setActiveTab('main');
  });

  els.persistenceTabBtn.addEventListener('click', function () {
    setActiveTab('persistence');
  });

  els.observabilityTabBtn.addEventListener('click', function () {
    setActiveTab('observability');
  });

  els.refreshStatsBtn.addEventListener('click', function () {
    handle(refreshStats);
  });

  els.refreshDlqBtn.addEventListener('click', function () {
    handle(refreshDlq);
  });

  els.refreshRealmsBtn.addEventListener('click', function () {
    handle(refreshSettings);
  });

  els.addRealmForm.addEventListener('submit', function (event) {
    event.preventDefault();
    handle(async function () {
      var realm = els.newRealm.value.trim();
      if (!realm)
        throw new Error('Realm name is required');
      var body = {
        command: 'add_realm',
        realm: realm,
        required: els.newRealmRequired.checked
      };
      if (els.newRealmEphemeral.checked) {
        body.ephemeral = true;
        var ttl = els.newRealmTtl.value.trim();
        if (ttl)
          body.ttl = ttl;
      }
      var response = await managementCommand(body);
      els.newRealm.value = '';
      els.newRealmEphemeral.checked = false;
      els.newRealmTtl.value = '';
      setSettings(response.settings);
      setStatus('Added ' + (body.ephemeral ? 'ephemeral ' : '') + 'realm ' + realm);
    });
  });

  els.externalAuthForm.addEventListener('submit', function (event) {
    event.preventDefault();
    handle(async function () {
      var url = els.externalAuthUrl.value.trim();
      if (!url)
        throw new Error('Validation URL is required — use Disable to turn external auth off');
      var body = {command: 'set_external_auth', auth_url: url};
      var secret = els.externalAuthSecret.value;
      if (secret)
        body.auth_secret = secret;
      var response = await managementCommand(body);
      setSettings(response.settings);
      setStatus('External auth updated');
    });
  });

  function renderMgmtTokenReveal(prefix, token) {
    els.mgmtTokenReveal.className = 'hidden-field visible';
    els.mgmtTokenReveal.innerHTML = '';

    var note = document.createElement('div');
    note.className = 'token-meta';
    note.textContent = 'New token for ' + prefix + ' — copy it now, it will not be shown again:';

    var valueRow = document.createElement('div');
    valueRow.className = 'reveal-row';

    var code = document.createElement('code');
    code.textContent = token;

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', function () {
      handle(async function () {
        await copyText(token);
        setStatus('Management token copied');
      });
    });

    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'secondary';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', function () {
      els.mgmtTokenReveal.className = 'hidden-field';
      els.mgmtTokenReveal.innerHTML = '';
    });

    valueRow.appendChild(code);
    valueRow.appendChild(copy);
    valueRow.appendChild(dismiss);
    els.mgmtTokenReveal.appendChild(note);
    els.mgmtTokenReveal.appendChild(valueRow);
  }

  els.addMgmtTokenForm.addEventListener('submit', function (event) {
    event.preventDefault();
    handle(async function () {
      var prefix = els.mgmtTokenPrefix.value.trim();
      if (!prefix)
        throw new Error('Realm prefix is required (e.g. realm:prefix:)');
      var token = randomHex(32);
      var response = await managementCommand({
        command: 'add_management_token',
        token: token,
        realm_prefix: prefix
      });
      els.mgmtTokenPrefix.value = '';
      renderMgmtTokenReveal(prefix, token);
      setSettings(response.settings);
      setStatus('Management token added for ' + prefix);
    });
  });

  els.disableExternalAuthBtn.addEventListener('click', function () {
    handle(async function () {
      var confirmed = window.confirm(
        'Disable external token validation?\n\n' +
        'Tokens unknown to this server will be rejected without consulting the ' +
        'external validator, and the stored callback secret is cleared.');
      if (!confirmed)
        return;
      var response = await managementCommand({command: 'set_external_auth', auth_url: '', auth_secret: ''});
      setSettings(response.settings);
      setStatus('External auth disabled');
    });
  });

  els.renameRealmForm.addEventListener('submit', function (event) {
    event.preventDefault();
    handle(async function () {
      var from = els.renameFrom.value.trim();
      var to = els.renameTo.value.trim();
      if (!from || !to)
        throw new Error('Current and new realm names are required');
      var response = await managementCommand({
        command: 'rename_realm',
        from: from,
        to: to
      });
      var oldKey = getLocalRealmManagerKey(from);
      if (oldKey) {
        saveLocalRealmManagerKey(to, oldKey);
        saveLocalRealmManagerKey(from, '');
      }
      var oldPsk = getLocalRealmPsk(from);
      if (oldPsk) {
        saveLocalRealmPsk(to, oldPsk);
        saveLocalRealmPsk(from, '');
      }
      els.renameFrom.value = '';
      els.renameTo.value = '';
      setSettings(response.settings);
      setStatus('Renamed realm ' + from + ' to ' + to);
    });
  });

  els.nextRequestBtn.addEventListener('click', function () {
    handle(async function () {
      var realm = getRequestRealmFilter();
      var response = await nextAuthorizationRequest(realm ? {realm: realm} : {});
      renderRequest(response.request);
      setStatus(response.request ? 'Loaded next request' : 'No pending requests');
    });
  });

  els.refreshRequestBtn.addEventListener('click', function () {
    handle(async function () {
      var realm = getRequestRealmFilter();
      var response = await nextAuthorizationRequest(realm ? {realm: realm} : {});
      renderRequest(response.request);
      setStatus(response.request ? 'Authorization request refreshed' : 'No pending requests');
    });
  });

  els.refreshTokensBtn.addEventListener('click', function () {
    handle(refreshSettings);
  });

  els.approveRequestBtn.addEventListener('click', function () {
    handle(async function () {
      if (!currentRequest)
        throw new Error('No request loaded');
      var response = await decideAuthorizationRequest({
        request_id: currentRequest.request_id,
        approved: true,
        role: els.approveRole.value
      });
      renderRequest(response.request);
      await refreshSettings();
      setStatus('Approved request ' + response.request.request_id);
    });
  });

  els.rejectRequestBtn.addEventListener('click', function () {
    handle(async function () {
      if (!currentRequest)
        throw new Error('No request loaded');
      var response = await decideAuthorizationRequest({
        request_id: currentRequest.request_id,
        approved: false,
        reason: els.rejectReason.value.trim() || null
      });
      renderRequest(response.request);
      setStatus('Rejected request ' + response.request.request_id);
    });
  });

  els.copySettingsBtn.addEventListener('click', function () {
    handle(async function () {
      await copyText(els.settingsOutput.textContent);
      setStatus('Settings copied');
    });
  });

  els.refreshPersistenceBtn.addEventListener('click', function () {
    handle(refreshSettings);
  });

  els.storageBackend.addEventListener('change', renderBackendOptions);

  els.persistenceForm.addEventListener('submit', function (event) {
    event.preventDefault();
    handle(async function () {
      var response = await managementCommand(buildPersistenceCommand());
      setSettings(response.settings);
      setStatus('Persistence updated to ' + response.settings.persistence.storage);
    });
  });

  var savedUrl = window.localStorage.getItem('tyoMqManagerUrl');
  if (savedUrl)
    els.serverUrl.value = savedUrl;

  var savedAdminToken = window.localStorage.getItem('tyoMqManagerAdminToken');
  if (savedAdminToken)
    els.adminToken.value = savedAdminToken;

  var savedNewRealm = window.localStorage.getItem('tyoMqManagerNewRealm');
  if (savedNewRealm)
    els.newRealm.value = savedNewRealm;

  var savedRealmFilter = window.localStorage.getItem('tyoMqManagerRealmFilter');
  if (savedRealmFilter)
    els.requestRealmCustom.value = savedRealmFilter;
  renderRealmFilter([]);
  renderPersistence();

  setActiveTab(window.localStorage.getItem('tyoMqManagerActiveTab') || 'main');

  if (els.serverUrl.value.trim() && els.adminToken.value.trim()) {
    setStatus('Connecting with saved credentials...');
    handle(connectManager);
  }

  function saveServerUrl() {
    var serverUrl = els.serverUrl.value.trim();
    if (serverUrl)
      window.localStorage.setItem('tyoMqManagerUrl', serverUrl);
    else
      window.localStorage.removeItem('tyoMqManagerUrl');
  }

  function saveOptionalInput(input, key) {
    var value = input.value.trim();
    if (value)
      window.localStorage.setItem(key, value);
    else
      window.localStorage.removeItem(key);
  }

  els.serverUrl.addEventListener('change', saveServerUrl);
  els.serverUrl.addEventListener('blur', saveServerUrl);
  els.adminToken.addEventListener('change', function () {
    saveOptionalInput(els.adminToken, 'tyoMqManagerAdminToken');
  });
  els.adminToken.addEventListener('blur', function () {
    saveOptionalInput(els.adminToken, 'tyoMqManagerAdminToken');
  });
  els.clearTokenBtn.addEventListener('click', function () {
    els.adminToken.value = '';
    window.localStorage.removeItem('tyoMqManagerAdminToken');
    setStatus('Saved admin token cleared');
  });
  els.newRealm.addEventListener('change', function () {
    saveOptionalInput(els.newRealm, 'tyoMqManagerNewRealm');
  });
  els.newRealm.addEventListener('blur', function () {
    saveOptionalInput(els.newRealm, 'tyoMqManagerNewRealm');
  });
  els.requestRealmFilter.addEventListener('change', function () {
    if (els.requestRealmFilter.value === '__custom') {
      els.requestRealmCustom.classList.add('visible');
      saveOptionalInput(els.requestRealmCustom, 'tyoMqManagerRealmFilter');
    }
    else {
      els.requestRealmCustom.classList.remove('visible');
      els.requestRealmCustom.value = '';
      saveOptionalInput(els.requestRealmFilter, 'tyoMqManagerRealmFilter');
    }
  });
  els.requestRealmCustom.addEventListener('change', function () {
    saveOptionalInput(els.requestRealmCustom, 'tyoMqManagerRealmFilter');
  });
  els.requestRealmCustom.addEventListener('blur', function () {
    saveOptionalInput(els.requestRealmCustom, 'tyoMqManagerRealmFilter');
  });
}());
