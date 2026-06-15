#!/usr/bin/env node
/**
 * Serve the static browser manager over localhost.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

var port = parseInt(process.env.TYO_MQ_MANAGER_WEB_PORT, 10) || 18080;
var root = path.resolve(__dirname, '..', 'web', 'client');

for (var i = 2; i < process.argv.length; i++) {
    switch (process.argv[i]) {
        case '-p':
        case '--port':
            port = parseInt(process.argv[++i], 10);
            break;
        default:
            console.error('Unknown option: ' + process.argv[i]);
            process.exit(1);
    }
}

var types = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8'
};

function send(res, status, body, contentType) {
    res.writeHead(status, {
        'content-type': contentType || 'text/plain; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'pragma': 'no-cache',
        'expires': '0'
    });
    res.end(body);
}

var server = http.createServer(function (req, res) {
    var pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    }
    catch (err) {
        send(res, 400, 'Bad request');
        return;
    }

    if (pathname === '/')
        pathname = '/manager.html';

    var target = path.resolve(root, '.' + pathname);
    if (target.indexOf(root + path.sep) !== 0 && target !== root) {
        send(res, 403, 'Forbidden');
        return;
    }

    fs.readFile(target, function (err, data) {
        if (err) {
            send(res, err.code === 'ENOENT' ? 404 : 500, err.code === 'ENOENT' ? 'Not found' : 'Server error');
            return;
        }

        send(res, 200, data, types[path.extname(target)] || 'application/octet-stream');
    });
});

server.listen(port, '127.0.0.1', function () {
    console.log('TYO MQ manager UI: http://127.0.0.1:' + port + '/manager.html');
});
