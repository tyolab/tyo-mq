/**
 * @file logger.js
 *
 * Levelled, coloured logger for tyo-mq.
 * Adapted from tyostocks/algo/utils/logger.js — standalone, no external deps.
 *
 * Levels (lower number = higher priority):
 *   CRITICAL  0  bright-red   — fatal misconfigurations, must never be ignored
 *   ERROR     1  red          — unexpected failures, always shown
 *   OUTPUT    2  white        — command results
 *   WARN      3  yellow       — recoverable problems / bad input
 *   LOG       4  cyan         — normal operational events (default level)
 *   INFO      8  green        — extra informational detail
 *   DEBUG    16  blue         — internal mechanics (message routing, etc.)
 *   TRACE    32  magenta      — very verbose, usually disabled
 */

'use strict';

const fs = require('fs');

// ANSI colour codes (foreground)
const theme_default = {
    output:   97,  // bright white
    log:      36,  // cyan
    info:     32,  // green
    warn:     33,  // yellow
    error:    31,  // red
    debug:    34,  // blue
    trace:    35,  // magenta
    critical: 91,  // bright red
};

function pad2(n)  { return String(n).padStart(2, '0'); }
function pad3(n)  { return String(n).padStart(3, '0'); }

function formatDate(d) {
    return d.getFullYear()
        + pad2(d.getMonth() + 1)
        + pad2(d.getDate())
        + pad2(d.getHours())
        + pad2(d.getMinutes())
        + pad2(d.getSeconds())
        + pad3(d.getMilliseconds());
}

function Logger(name, options) {
    options = options || {};

    this.name   = name || 'tyo-mq';
    this.theme  = options.theme  || theme_default;
    this.out    = options.out    || process.stdout;
    this.suffix = options.suffix || '\n';
    this.level  = options.level  !== undefined ? options.level : Logger.LOG;

    this.logger_file = options.logger_file || null;
    this.errors_file = options.errors_file || null;

    // keep refs to originals so internal helpers can always write
    this._stdout_write = process.stdout.write.bind(process.stdout);
}

Logger.CRITICAL = 0;
Logger.ERROR    = 1;
Logger.OUTPUT   = 2;
Logger.WARN     = 3;
Logger.LOG      = 4;
Logger.INFO     = 8;
Logger.DEBUG    = 16;
Logger.TRACE    = 32;

Logger.prototype.set_level = function (level) {
    const map = { CRITICAL:0, ERROR:1, OUTPUT:2, WARN:3, LOG:4, INFO:8, DEBUG:16, TRACE:32 };
    if (typeof level === 'string') {
        const v = map[level.toUpperCase()];
        if (v === undefined) throw new Error('Invalid log level: ' + level);
        this.level = v;
    } else if (typeof level === 'number') {
        this.level = level;
    } else {
        throw new Error('level must be a string or number');
    }
};

Logger.prototype._print_one = function (what, color, step, date) {
    date = date || new Date();
    step = step || 0;

    const prefix = '[' + this.name + '|' + formatDate(date) + '] ';
    const indent = '  '.repeat(step);
    const ansiOn  = '\x1b[' + (color || 35) + 'm';
    const ansiOff = '\x1b[0m';

    this._stdout_write(prefix + indent + ansiOn + String(what) + ansiOff + this.suffix);
};

Logger.prototype._print = function (what, color, step, date) {
    step = step || 0;
    if (Array.isArray(what)) {
        for (const item of what) this._print(item, color, step + 1, date);
    } else if (what !== null && typeof what === 'object' && !(what instanceof Error)) {
        for (const key of Object.keys(what)) {
            const val = what[key];
            if (typeof val === 'object' || Array.isArray(val))
                this._print(val, color, step + 1, date);
            else
                this._print_one(key + ': ' + val, color, step + 1, date);
        }
    } else {
        this._print_one(what instanceof Error ? what.stack : what, color, step, date);
    }
};

Logger.prototype._file_write = function (logger_file, level_string, what) {
    if (!logger_file) return;
    const date   = new Date();
    const prefix = '[' + this.name + '|' + formatDate(date) + '] ';
    const tag    = level_string ? '(' + level_string + ') ' : '';

    const lines = (Array.isArray(what) ? what : [what]).map(item => {
        if (!item && item !== 0) return null;
        return prefix + tag + (item instanceof Error ? item.stack : String(item));
    }).filter(Boolean);

    if (lines.length) fs.appendFileSync(logger_file, lines.join('\n') + '\n');
};

// ── public methods ────────────────────────────────────────────────────────────

Logger.prototype.critical = function (...args) {
    // always shown regardless of level
    this._print(args, this.theme.critical);
    this._file_write(this.errors_file, 'CRITICAL', args);
};

Logger.prototype.error = function (...args) {
    // always shown regardless of level
    this._print(args, this.theme.error);
    this._file_write(this.errors_file, 'ERROR', args);
};

Logger.prototype.warn = function (...args) {
    if (this.level >= Logger.WARN) this._print(args, this.theme.warn);
    this._file_write(this.logger_file, 'WARN', args);
};

Logger.prototype.output = function (...args) {
    if (this.level >= Logger.OUTPUT) this._print(args, this.theme.output);
};

Logger.prototype.log = function (...args) {
    if (this.level >= Logger.LOG) this._print(args, this.theme.log);
    this._file_write(this.logger_file, 'LOG', args);
};

Logger.prototype.info = function (...args) {
    if (this.level >= Logger.INFO) this._print(args, this.theme.info);
    this._file_write(this.logger_file, 'INFO', args);
};

Logger.prototype.debug = function (...args) {
    if (this.level >= Logger.DEBUG) this._print(args, this.theme.debug);
};

Logger.prototype.trace = function (...args) {
    if (this.level >= Logger.TRACE) this._print(args, this.theme.trace);
};

module.exports = Logger;
