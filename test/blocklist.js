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

var seed

server.on('error', function () {})

test('seed should connect to the tracker', function (t) {
  t.plan(3)

  server.once('listening', function () {
    t.ok(true, 'tracker should be listening')
    seed = torrents(torrent, {
      dht: false,
      path: path.join(__dirname, 'data')
    })
    seed.listen(6882)
    seed.once('ready', t.ok.bind(t, true, 'should be ready'))
  })
  server.once('start', function (addr) {
    t.equal(addr, '127.0.0.1:6882')
  })
  server.listen(12345)
})

test('peer should block the seed via blocklist', function (t) {
  t.plan(3)
  var peer = torrents(torrent, {
    dht: false,
    blocklist: [
      { start: '127.0.0.1', end: '127.0.0.1' }
    ]
  })

  var blockedPeer = false
  var ready = false
  var maybeDone = function () {
    if (blockedPeer && ready) {
      peer.destroy(t.ok.bind(t, true, 'peer should be destroyed'))
    }
  }

  peer.once('blocked-peer', function (addr) {
    t.like(addr, /127\.0\.0\.1/)
    blockedPeer = true
    maybeDone()
  })
  peer.once('ready', function () {
    t.ok(true, 'peer should be ready')
    ready = true
    maybeDone()
  })
})

test('peer should block the seed via explicit block', function (t) {
  t.plan(3)
  var peer = torrents(torrent, { dht: false })
  peer.block('127.0.0.1:6882')

  var blockedPeer = false
  var ready = false
  var maybeDone = function () {
    if (blockedPeer && ready) {
      peer.destroy(t.ok.bind(t, true, 'peer should be destroyed'))
    }
  }

  peer.once('blocked-peer', function (addr) {
    t.like(addr, /127\.0\.0\.1/)
    blockedPeer = true
    maybeDone()
  })
  peer.once('ready', function () {
    t.ok(true, 'peer should be ready')
    ready = true
    maybeDone()
  })
})

test('cleanup', function (t) {
  t.plan(2)
  seed.destroy(t.ok.bind(t, true, 'seed should be destroyed'))
  server.close(t.ok.bind(t, true, 'tracker should be closed'))
})
