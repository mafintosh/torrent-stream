var test = require('tap').test;
var torrents = require('../');
var fs = require('fs');
var path = require('path');
var parseTorrent = require('parse-torrent');
var tracker = require('bittorrent-tracker');
var server = new tracker.Server();

var torrent = parseTorrent(fs.readFileSync(path.join(__dirname, 'data', 'test.torrent')));

var fixture = torrents(torrent, {
	dht: false,
	path: path.join(__dirname, 'data')
});
fixture.listen(6882);

server.on('error', function () {
});

test('seed should connect to the tracker', function (t) {
	t.plan(3);

	server.on('listening', t.ok.bind(t, true, 'tracker should be listening'));
	server.on('start', function (addr) {
		if (addr === '127.0.0.1:6882') {
			t.ok(true, 'seed connected');
		}
	});
	server.listen(12345);

	fixture.on('ready', t.ok.bind(t, true, 'should be ready'));
});

test('peer should connect to the swarm using .torrent file', function (t) {
	t.plan(4);
	var engine = torrents(torrent, { dht: false });
	engine.on('ready', function () {
		t.ok(true, 'should be ready');
		engine.destroy(t.ok.bind(t, true, 'should be destroyed'));
	});
	server.on('start', function (addr) {
		if (addr === '127.0.0.1:6881') {
			t.ok(true, 'peer connected');
		}
	});
	server.on('stop', function (addr) {
		if (addr === '127.0.0.1:6881') {
			t.ok(true, 'peer disconnected');
		}
	});
});

test('peer should connect to the swarm using magnet link', function (t) {
	t.plan(3);
	var engine = torrents('magnet:?xt=urn:btih:1cb9681dccbe6ef86ac797ab93840a4f0c4ccae8' +
		'&tr=http%3A%2F%2F127.0.0.1%3A12345%2Fannounce', { dht: false });
	engine.on('ready', function () {
		t.ok(true, 'should be ready');
		engine.destroy(t.ok.bind(t, true, 'should be destroyed'));
	});
	server.on('start', function (addr) {
		if (addr === '127.0.0.1:6881') {
			t.ok(true, 'peer connected');
		}
	});
});

test('cleanup', function (t) {
	t.plan(2);
	fixture.destroy(t.ok.bind(t, true, 'should be destroyed'));
	server.close(t.ok.bind(t, true, 'tracker should be closed'));
});