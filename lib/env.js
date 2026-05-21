/**
 * Minimal .env helpers for tyo-mq.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseEnv(raw) {
    var result = {};
    String(raw || '').split(/\r?\n/).forEach(function (line) {
        var trimmed = line.trim();
        if (!trimmed || trimmed[0] === '#')
            return;

        var idx = trimmed.indexOf('=');
        if (idx < 0)
            return;

        var key = trimmed.slice(0, idx).trim();
        var value = trimmed.slice(idx + 1).trim();
        if ((value[0] === '"' && value[value.length - 1] === '"')
                || (value[0] === "'" && value[value.length - 1] === "'")) {
            value = value.slice(1, -1);
        }
        if (key)
            result[key] = value;
    });
    return result;
}

function loadEnvFile(filePath) {
    filePath = path.resolve(filePath || '.env');
    if (!fs.existsSync(filePath))
        return {};

    var parsed = parseEnv(fs.readFileSync(filePath, 'utf8'));
    Object.keys(parsed).forEach(function (key) {
        if (process.env[key] === undefined)
            process.env[key] = parsed[key];
    });
    return parsed;
}

function quoteEnv(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function appendEnvValue(filePath, key, value) {
    filePath = path.resolve(filePath || '.env');
    var dir = path.dirname(filePath);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, {recursive: true});

    var prefix = '';
    if (fs.existsSync(filePath)) {
        var current = fs.readFileSync(filePath, 'utf8');
        if (current.length > 0 && current[current.length - 1] !== '\n')
            prefix = '\n';
    }

    fs.appendFileSync(filePath, prefix + key + '=' + quoteEnv(value) + '\n', {mode: 0o600});
    process.env[key] = String(value);
}

module.exports = {
    appendEnvValue: appendEnvValue,
    loadEnvFile: loadEnvFile,
    parseEnv: parseEnv
};
