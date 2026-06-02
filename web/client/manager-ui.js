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
    mainTab: document.getElementById('main-tab'),
    persistenceTab: document.getElementById('persistence-tab'),
    showSettingsBtn: document.getElementById('show-settings-btn'),
    refreshRealmsBtn: document.getElementById('refresh-realms-btn'),
    addRealmForm: document.getElementById('add-realm-form'),
    newRealm: document.getElementById('new-realm'),
    newRealmRequired: document.getElementById('new-realm-required'),
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
    renderPersistence();
  }

  function setActiveTab(name) {
    var isPersistence = name === 'persistence';
    els.mainTabBtn.classList.toggle('active', !isPersistence);
    els.persistenceTabBtn.classList.toggle('active', isPersistence);
    els.mainTab.classList.toggle('active', !isPersistence);
    els.persistenceTab.classList.toggle('active', isPersistence);
    window.localStorage.setItem('tyoMqManagerActiveTab', isPersistence ? 'persistence' : 'main');
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
      var row = document.createElement('div');
      row.className = 'realm-row';

      var label = document.createElement('div');
      label.className = 'realm-name';
      label.textContent = name;

      var pill = document.createElement('span');
      var required = !!(realms[name] && realms[name].required);
      pill.className = required ? 'pill' : 'pill open';
      pill.textContent = required ? 'auth required' : 'open';

      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'secondary';
      toggle.textContent = required ? 'Disable auth' : 'Require auth';
      toggle.addEventListener('click', function () {
        setRealmAuth(name, !required);
      });

      row.appendChild(label);
      row.appendChild(pill);
      row.appendChild(toggle);
      els.realmsList.appendChild(row);
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

  async function setRealmAuth(realm, required) {
    var response = await managementCommand({
      command: 'set_realm_auth',
      realm: realm,
      required: required
    });
    setSettings(response.settings);
    setStatus('Updated realm ' + realm);
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
    handle(async function () {
      await refreshSettings();
      setStatus('Connected. Admin signature accepted.');
    });
  });

  els.showSettingsBtn.addEventListener('click', function () {
    handle(refreshSettings);
  });

  els.mainTabBtn.addEventListener('click', function () {
    setActiveTab('main');
  });

  els.persistenceTabBtn.addEventListener('click', function () {
    setActiveTab('persistence');
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
      var response = await managementCommand({
        command: 'add_realm',
        realm: realm,
        required: els.newRealmRequired.checked
      });
      els.newRealm.value = '';
      setSettings(response.settings);
      setStatus('Added realm ' + realm);
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
      await navigator.clipboard.writeText(els.settingsOutput.textContent);
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
