/**
 * Socket.IO /remote namespace for one-time-ticket binary streaming sessions.
 *
 * Each session has exactly two logical parties, joined at `auth` time from a
 * one-time ticket: the agent (room `session:{id}:agent`) and the viewers
 * (room `session:{id}:viewers`). Everything after auth is a content-agnostic
 * relay between the two sides, driven by a rule table:
 *
 *   { from: 'agent'|'viewer'|'any',        // sender role guard
 *     to:   'agent'|'viewers'|'opposite',  // destination room
 *     binary: true,                        // base64 {frame} -> Buffer (frame only)
 *     enabled: false }                     // drop the event
 *
 * Built-in rules cover streaming, input, and WebRTC signaling. Operators can
 * add/override/disable rules with a hot-reloadable `remote.relay` settings
 * block, and events with no rule relay to the opposite role's room by
 * default (`remote.relay_unlisted: 'off'` for a strict allow-list). New
 * event names therefore never require a server change: the relay forwards
 * opaque payloads between the session's two authenticated parties, and room
 * scoping keeps every session isolated.
 */

'use strict';

const crypto = require('crypto');

// Built-in relay rules. `frame` carries base64 JPEG and is re-emitted as a
// binary Buffer; everything else is opaque JSON relayed verbatim. The rtc.*
// events are the WebRTC signaling bus (the agent is the offerer; rtc.ready
// is the viewer telling the agent it is subscribed and the offer may be
// sent; rtc.ice flows both ways, each side's candidates to the other).
var DEFAULT_RELAY = {
    'frame':             {from: 'agent',  to: 'viewers', binary: true},
    'input.mouse':       {from: 'viewer', to: 'agent'},
    'input.keyboard':    {from: 'viewer', to: 'agent'},
    'input.sas':         {from: 'viewer', to: 'agent'},
    'remote.setmonitor': {from: 'viewer', to: 'agent'},
    'rtc.offer':         {from: 'agent',  to: 'viewers'},
    'rtc.answer':        {from: 'viewer', to: 'agent'},
    'rtc.ready':         {from: 'viewer', to: 'agent'},
    'rtc.ice':           {from: 'any',    to: 'opposite'}
};

// Never relayed and not overridable via settings: our auth control events
// (a party must not be able to forge server-origin auth_ok/auth_error at
// the other side) plus socket.io's reserved names.
var RESERVED_EVENTS = {
    'auth': true,
    'auth_ok': true,
    'auth_error': true,
    'connect': true,
    'connect_error': true,
    'disconnect': true,
    'disconnecting': true,
    'newListener': true,
    'removeListener': true
};

var VALID_DESTINATIONS = {agent: true, viewers: true, opposite: true};

// Normalize an operator-supplied rule. Returns null for an unusable rule
// (which drops the event — misconfiguration must fail closed, not open).
function normalizeRelayRule(rule) {
    if (!rule || typeof rule !== 'object')
        return null;
    if (rule.enabled === false)
        return {enabled: false};
    var to = rule.to;
    if (!VALID_DESTINATIONS[to])
        return null;
    var from = rule.from === 'agent' || rule.from === 'viewer' ? rule.from : 'any';
    return {from: from, to: to, binary: !!rule.binary};
}

module.exports = function attachRemoteNamespace(io, options, getLiveConfig) {
    options = options || {};
    var ticketTtlMs = options.ticket_ttl_ms || options.ticketTtlMs || 60 * 1000;
    var ticketCleanupMs = options.ticket_cleanup_ms || options.ticketCleanupMs || ticketTtlMs + 5000;

    // Live view of the `remote` settings block so relay rules hot-reload;
    // falls back to the attach-time options when no getter is provided.
    var liveConfig = typeof getLiveConfig === 'function'
        ? getLiveConfig
        : function () { return options; };

    // The merged rule table is rebuilt at most once a second — config
    // changes apply within ~1s without paying a merge per relayed frame.
    var relayCache = null;
    var relayCacheAt = 0;

    function getRelayConfig() {
        var now = Date.now();
        if (relayCache && now - relayCacheAt < 1000)
            return relayCache;

        var config = liveConfig() || {};
        var table = {};
        Object.keys(DEFAULT_RELAY).forEach(function (event) {
            table[event] = DEFAULT_RELAY[event];
        });
        var overrides = config.relay || {};
        Object.keys(overrides).forEach(function (event) {
            if (RESERVED_EVENTS[event])
                return;
            table[event] = normalizeRelayRule(overrides[event]);
        });

        var unlisted = config.relay_unlisted !== undefined ? config.relay_unlisted
            : (config.relayUnlisted !== undefined ? config.relayUnlisted : 'opposite');

        relayCache = {
            table: table,
            unlisted: (unlisted === 'off' || unlisted === false) ? 'off' : 'opposite'
        };
        relayCacheAt = now;
        return relayCache;
    }

    // ticket -> {session_id, realm, machine_id, role, expires}
    var tickets = new Map();
    // session_id -> {agent: socket.id|null, viewers: Set<socket.id>}
    var sessions = new Map();

    function issueTicket(params) {
        params = params || {};
        if (!params.session_id)
            throw new Error('session_id is required');

        var role = params.role === 'viewer' ? 'viewer' : 'agent';
        var ticket = crypto.randomBytes(16).toString('hex');
        tickets.set(ticket, {
            session_id: String(params.session_id),
            realm: params.realm || null,
            machine_id: params.machine_id || null,
            role: role,
            expires: Date.now() + ticketTtlMs
        });
        setTimeout(function () {
            tickets.delete(ticket);
        }, ticketCleanupMs).unref();
        return ticket;
    }

    function publicSession(sessionId, session) {
        if (!session)
            return null;
        return {
            session_id: sessionId,
            agent_connected: !!session.agent,
            viewer_count: session.viewers.size
        };
    }

    function getSession(sessionId) {
        return publicSession(sessionId, sessions.get(sessionId));
    }

    function listSessions() {
        var result = [];
        sessions.forEach(function (session, sessionId) {
            result.push(publicSession(sessionId, session));
        });
        return result;
    }

    var nsp = io.of('/remote');

    nsp.on('connection', function (socket) {
        socket.remoteSession = null;

        socket.on('auth', function (data) {
            data = data || {};
            var entry = tickets.get(data.ticket);
            if (!entry || Date.now() > entry.expires) {
                socket.emit('auth_error', {message: 'Invalid or expired ticket'});
                socket.disconnect(true);
                return;
            }
            tickets.delete(data.ticket);

            if (data.session_id && String(data.session_id) !== entry.session_id) {
                socket.emit('auth_error', {message: 'Ticket session mismatch'});
                socket.disconnect(true);
                return;
            }

            if (data.role && String(data.role) !== entry.role) {
                socket.emit('auth_error', {message: 'Ticket role mismatch'});
                socket.disconnect(true);
                return;
            }

            var sessionId = entry.session_id;
            socket.remoteSession = {
                session_id: sessionId,
                realm: entry.realm,
                machine_id: entry.machine_id,
                role: entry.role
            };

            if (!sessions.has(sessionId))
                sessions.set(sessionId, {agent: null, viewers: new Set()});

            var session = sessions.get(sessionId);
            if (entry.role === 'agent') {
                session.agent = socket.id;
                socket.join('session:' + sessionId + ':agent');
            }
            else {
                session.viewers.add(socket.id);
                socket.join('session:' + sessionId + ':viewers');
            }

            socket.emit('auth_ok', {session_id: sessionId, role: entry.role});
        });

        // Single relay dispatcher for every post-auth event. onAny fires for
        // all inbound events, so no per-event handlers exist alongside it —
        // that would double-deliver.
        socket.onAny(function (event) {
            var session = socket.remoteSession;
            if (!session || RESERVED_EVENTS[event])
                return;

            var relay = getRelayConfig();
            var rule = event in relay.table ? relay.table[event]
                : (relay.unlisted === 'opposite' ? {from: 'any', to: 'opposite'} : null);
            if (!rule || rule.enabled === false)
                return;
            if (rule.from !== 'any' && session.role !== rule.from)
                return;

            var destination = rule.to === 'opposite'
                ? (session.role === 'agent' ? 'viewers' : 'agent')
                : rule.to;
            var room = 'session:' + session.session_id + ':' + destination;

            if (rule.binary) {
                // frame: base64 payload re-emitted as a binary Buffer.
                var data = arguments.length > 1 ? arguments[1] : null;
                if (!data || !data.frame)
                    return;
                socket.to(room).emit(event, Buffer.from(String(data.frame), 'base64'));
                return;
            }

            // Opaque relay: forward all payload args verbatim, minus any
            // acknowledgement callback (functions cannot cross the wire).
            var payload = [];
            for (var i = 1; i < arguments.length; i++) {
                if (typeof arguments[i] !== 'function')
                    payload.push(arguments[i]);
            }
            if (payload.length === 0)
                payload.push({});
            var target = socket.to(room);
            target.emit.apply(target, [event].concat(payload));
        });

        socket.on('disconnect', function () {
            if (!socket.remoteSession)
                return;

            var sessionId = socket.remoteSession.session_id;
            var session = sessions.get(sessionId);
            if (!session)
                return;

            if (socket.remoteSession.role === 'agent')
                session.agent = null;
            else
                session.viewers.delete(socket.id);

            if (!session.agent && session.viewers.size === 0)
                sessions.delete(sessionId);
        });
    });

    return {
        getSession: getSession,
        issueTicket: issueTicket,
        listSessions: listSessions,
        sessions: sessions,
        tickets: tickets
    };
};
