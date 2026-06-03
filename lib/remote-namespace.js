/**
 * Socket.IO /remote namespace for one-time-ticket binary streaming sessions.
 */

'use strict';

const crypto = require('crypto');

module.exports = function attachRemoteNamespace(io, options) {
    options = options || {};
    var ticketTtlMs = options.ticket_ttl_ms || options.ticketTtlMs || 60 * 1000;
    var ticketCleanupMs = options.ticket_cleanup_ms || options.ticketCleanupMs || ticketTtlMs + 5000;

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

        socket.on('frame', function (data) {
            if (!socket.remoteSession || socket.remoteSession.role !== 'agent')
                return;
            if (!data || !data.frame)
                return;

            var sessionId = socket.remoteSession.session_id;
            var frame = Buffer.from(String(data.frame), 'base64');
            nsp.to('session:' + sessionId + ':viewers').emit('frame', frame);
        });

        socket.on('input.mouse', function (data) {
            if (!socket.remoteSession || socket.remoteSession.role !== 'viewer')
                return;
            var sessionId = socket.remoteSession.session_id;
            nsp.to('session:' + sessionId + ':agent').emit('input.mouse', data || {});
        });

        socket.on('input.keyboard', function (data) {
            if (!socket.remoteSession || socket.remoteSession.role !== 'viewer')
                return;
            var sessionId = socket.remoteSession.session_id;
            nsp.to('session:' + sessionId + ':agent').emit('input.keyboard', data || {});
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
