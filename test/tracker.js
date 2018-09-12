var test = require('tap').test
var torrents = require('../')
var fs = require('fs')
var path = require('path')
var rimraf = require('rimraf')
var tracker = require('bittorrent-tracker')
var server = new tracker.Server()

var torrent = fs.readFileSync(path.join(__dirname, 'data', 'test.torrent'))
var tmpPath = path.join(__dirname, '..', 'torrents', 'test')
rimraf.sync(tmpPath)

var fixture

server.on('error', function () {})

test('seed should connect to the tracker', function (t) {
  t.plan(3)

  server.once('listening', function () {
    t.ok(true, 'tracker should be listening')
    fixture = torrents(torrent, {
      dht: false,
      path: path.join(__dirname, 'data')
    })
    fixture.listen(6882)
    fixture.once('ready', t.ok.bind(t, true, 'should be ready'))
  })
  server.once('start', function (addr) {
    t.equal(addr, '127.0.0.1:6882')
  })
  server.listen(12345)
})

test('peer should connect to the swarm using .torrent file', function (t) {
  t.plan(4)
  var engine = torrents(torrent, { dht: false })
  engine.once('ready', function () {
    t.ok(true, 'should be ready')
    engine.destroy(function () {
      engine.remove(t.ok.bind(t, true, 'should be destroyed'))
    })
  })
  server.once('start', function (addr) {
    t.equal(addr, '127.0.0.1:6881')
  })
  server.once('stop', function (addr) {
    t.equal(addr, '127.0.0.1:6881')
  })
})

test('peer should connect to the swarm using magnet link', function (t) {
  t.plan(4)
  var engine = torrents('magnet:?xt=urn:btih:1cb9681dccbe6ef86ac797ab93840a4f0c4ccae8' +
    '&tr=http%3A%2F%2F127.0.0.1%3A12345%2Fannounce', { dht: false, tmp: tmpPath })
  engine.once('ready', function () {
    t.ok(true, 'should be ready')
    engine.destroy(function () {
      engine.remove(t.ok.bind(t, true, 'should be destroyed'))
    })
  })
  server.once('start', function (addr) {
    t.equal(addr, '127.0.0.1:6881')
  })
  server.once('stop', function (addr) {
    t.equal(addr, '127.0.0.1:6881')
  })
})

test('peer should connect to the swarm using magnet link and trackers', function (t) {
  t.plan(4)
  var engine = torrents('magnet:?xt=urn:btih:1cb9681dccbe6ef86ac797ab93840a4f0c4ccae8',
    { dht: false, tmp: tmpPath, trackers: ['http://127.0.0.1:12345/announce'] })
  engine.once('ready', function () {
    t.ok(true, 'should be ready')
    engine.destroy(function () {
      engine.remove(t.ok.bind(t, true, 'should be destroyed'))
    })
  })
  server.once('start', function (addr) {
    t.equal(addr, '127.0.0.1:6881')
  })
  server.once('stop', function (addr) {
    t.equal(addr, '127.0.0.1:6881')
  })
})

test('peer should connect to an alternate tracker', function (t) {
  t.plan(5)
  var engine = null
  var server = new tracker.Server()
  server.once('listening', function () {
    t.ok(true, 'tracker should be listening')

    engine = torrents(torrent, { dht: false, trackers: ['http://127.0.0.1:54321/announce'] })
    engine.once('ready', function () {
      t.ok(true, 'should be ready')
    })
  })
  server.once('start', function (addr) {
    t.equal(addr, '127.0.0.1:6881')

    engine.destroy(function () {
      engine.remove(t.ok.bind(t, true, 'should be destroyed'))
    })
    server.close(t.ok.bind(t, true, 'tracker should be closed'))
  })
  server.listen(54321)
})

test('cleanup', function (t) {
  t.plan(2)
  fixture.destroy(t.ok.bind(t, true, 'should be destroyed'))
  server.close(t.ok.bind(t, true, 'tracker should be closed'))
})
