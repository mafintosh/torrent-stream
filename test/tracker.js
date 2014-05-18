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
fixture.listen(16881);

test('should connect to the tracker', function (t) {
	t.plan(3);

	server.on('error', function (err) {
		t.fail(err.message);
	});
	server.on('listening', t.ok.bind(t, true, 'tracker should be listening'));
	server.on('start', function (addr) {
		t.equal(addr, '127.0.0.1:16881');
	});
	server.listen(12345);

	fixture.on('ready', t.ok.bind(t, true, 'should be ready'));
});

test('cleanup', function (t) {
	t.plan(2);
	fixture.destroy(t.ok.bind(t, true, 'torrent should be destroyed'));
	server.close(t.ok.bind(t, true, 'tracker should be closed'));
});