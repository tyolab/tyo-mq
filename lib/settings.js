/**
 * @file settings.js
 *
 * Hot-loadable settings store.
 *
 * Usage:
 *   const Settings = require('./settings');
 *   const s = new Settings({ auth: { enabled: false } });
 *   s.watch('/etc/tyo-mq.json');          // reload on file change
 *   s.get('auth')                         // always returns current value
 *   s.on('change', (next, prev) => {})    // notified on every reload
 *   s.reload()                            // force manual reload
 *   s.close()                             // stop watching
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const EventEmitter = require('events');

function Settings(initial) {
    EventEmitter.call(this);
    this._data     = this._clone(initial || {});
    this._filePath = null;
    this._watcher  = null;
    this._timer    = null;
}

Settings.prototype = Object.create(EventEmitter.prototype);
Settings.prototype.constructor = Settings;

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Return the current value of a top-level key, or the entire settings object.
 */
Settings.prototype.get = function (key) {
    return key === undefined ? this._clone(this._data) : this._data[key];
};

/**
 * Merge a plain object into current settings (no file involved).
 * Triggers a 'change' event.
 */
Settings.prototype.merge = function (partial) {
    var prev = this._clone(this._data);
    this._data = this._deepMerge(this._data, partial);
    this.emit('change', this._clone(this._data), prev);
};

/**
 * Replace settings entirely from a plain object.
 * Triggers a 'change' event.
 */
Settings.prototype.replace = function (data) {
    var prev = this._clone(this._data);
    this._data = this._clone(data || {});
    this.emit('change', this._clone(this._data), prev);
};

/**
 * Start watching a JSON settings file.  The file is loaded immediately; on
 * every subsequent change the file is re-read and a 'change' event fires.
 *
 * @param {string} filePath  Absolute or relative path to a JSON file.
 * @param {object} [opts]
 * @param {number} [opts.debounce=150]  Milliseconds to wait after a fs event
 *                                      before reading — editors write in bursts.
 * @param {boolean} [opts.merge=true]   true: deep-merge file into current
 *                                      settings; false: replace entirely.
 */
Settings.prototype.watch = function (filePath, opts) {
    opts = opts || {};
    this._filePath  = path.resolve(filePath);
    this._debounce  = opts.debounce !== undefined ? opts.debounce : 150;
    this._mergeMode = opts.merge    !== undefined ? opts.merge    : true;

    this._loadFile();   // immediate load

    var self = this;

    try {
        this._watcher = fs.watch(this._filePath, function (eventType) {
            if (eventType !== 'change' && eventType !== 'rename')
                return;
            // debounce: editors (vim, vscode) can emit several events per save
            clearTimeout(self._timer);
            self._timer = setTimeout(function () {
                self._loadFile();
            }, self._debounce);
        });

        this._watcher.on('error', function (err) {
            self.emit('error', err);
        });
    }
    catch (err) {
        this.emit('error', err);
    }

    // SIGHUP = conventional "reload config" signal on Unix
    this._sighupHandler = function () { self._loadFile(); };
    process.on('SIGHUP', this._sighupHandler);

    return this;
};

/**
 * Force a reload from the watched file (no-op if no file is being watched).
 */
Settings.prototype.reload = function () {
    if (this._filePath)
        this._loadFile();
    return this;
};

/**
 * Synchronously reload from the watched file and return once applied. Unlike
 * reload() (which reads asynchronously), this guarantees the new settings are
 * in effect before it returns — useful for request/response flows that must
 * report the reloaded state. Throws on read/parse errors.
 */
Settings.prototype.reloadSync = function () {
    if (!this._filePath)
        return this;

    var raw    = fs.readFileSync(this._filePath, 'utf8');
    var parsed = JSON.parse(raw);

    var prev = this._clone(this._data);
    if (this._mergeMode)
        this._data = this._deepMerge(this._data, parsed);
    else
        this._data = this._clone(parsed);

    this.emit('change', this._clone(this._data), prev);
    return this;
};

/**
 * Stop watching the file and remove the SIGHUP listener.
 */
Settings.prototype.close = function () {
    if (this._watcher) {
        this._watcher.close();
        this._watcher = null;
    }
    clearTimeout(this._timer);
    if (this._sighupHandler)
        process.removeListener('SIGHUP', this._sighupHandler);
    return this;
};

// ── private helpers ───────────────────────────────────────────────────────────

Settings.prototype._loadFile = function () {
    var self = this;

    fs.readFile(this._filePath, 'utf8', function (err, raw) {
        if (err) {
            self.emit('error', new Error('Settings: could not read ' + self._filePath + ': ' + err.message));
            return;
        }

        var parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (e) {
            self.emit('error', new Error('Settings: invalid JSON in ' + self._filePath + ': ' + e.message));
            return;
        }

        var prev = self._clone(self._data);
        if (self._mergeMode)
            self._data = self._deepMerge(self._data, parsed);
        else
            self._data = self._clone(parsed);

        self.emit('change', self._clone(self._data), prev);
    });
};

Settings.prototype._clone = function (obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    try { return JSON.parse(JSON.stringify(obj)); }
    catch (_) { return obj; }
};

Settings.prototype._deepMerge = function (target, source) {
    var result = this._clone(target);
    if (!source || typeof source !== 'object') return result;
    for (var key in source) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
                && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
            result[key] = this._deepMerge(result[key], source[key]);
        } else {
            result[key] = this._clone(source[key]);
        }
    }
    return result;
};

module.exports = Settings;
