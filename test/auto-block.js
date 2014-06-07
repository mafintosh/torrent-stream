var test = require('tap').test;
var torrents = require('../');
var fs = require('fs-extra');
var path = require('path');
var parseTorrent = require('parse-torrent');

var torrent = parseTorrent(fs.readFileSync(path.join(__dirname, 'data', 'test.torrent')));
var tmpPath = path.join(__dirname, '..', 'torrents', 'test');
fs.removeSync(tmpPath);
fs.copySync(path.join(__dirname, 'data'), tmpPath);

var fixture = torrents(torrent, {
	dht: false,
	tracker: false,
	path: tmpPath
});

fixture.listen(10000);

test('fixture can verify the torrent', function(t) {
	t.plan(2);
	fixture.on('ready', function() {
		t.ok(true, 'should be ready');
		t.deepEqual(fixture.bitfield.buffer.toString('hex'), 'c0', 'should verify all the pieces');
	});
});

test('peer should be blocked on bad piece', function(t) {
	t.plan(4);

	fixture.store.write(0, new Buffer(1 << 14), function() {
		t.ok(true, 'should be written');

		var engine = torrents(torrent, {
			dht: false,
			tracker: false,
			tmp: tmpPath
		});

		engine.on('blocked-peer', function(addr, reason) {
			t.equal(addr, '127.0.0.1:10000');
			t.equal(reason, 'Blocked');
		});

		engine.connect('127.0.0.1:10000');

		engine.on('ready', function() {
			t.ok(true, 'should be ready');
			engine.files[0].select();
		});
	});
});

test('cleanup', function(t) {
	t.plan(1);
	fixture.destroy(t.ok.bind(t, true, 'should be destroyed'));
});