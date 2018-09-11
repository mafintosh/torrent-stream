var hat = require('hat')
var pws = require('peer-wire-swarm')
var bncode = require('bncode')
var crypto = require('crypto')
var bitfield = require('bitfield')
var parseTorrent = require('parse-torrent')
var mkdirp = require('mkdirp')
var events = require('events')
var path = require('path')
var fs = require('fs')
var os = require('os')
var eos = require('end-of-stream')
var piece = require('torrent-piece')
var rimraf = require('rimraf')
var FSChunkStore = require('fs-chunk-store')
var ImmediateChunkStore = require('immediate-chunk-store')
var peerDiscovery = require('torrent-discovery')
var bufferFrom = require('buffer-from')

var blocklist = require('ip-set')
var exchangeMetadata = require('./lib/exchange-metadata')
var fileStream = require('./lib/file-stream')

var MAX_REQUESTS = 5
var CHOKE_TIMEOUT = 5000
var REQUEST_TIMEOUT = 30000
var SPEED_THRESHOLD = 3 * piece.BLOCK_LENGTH
var DEFAULT_PORT = 6881

var BAD_PIECE_STRIKES_MAX = 3
var BAD_PIECE_STRIKES_DURATION = 120000 // 2 minutes

var RECHOKE_INTERVAL = 10000
var RECHOKE_OPTIMISTIC_DURATION = 2

var TMP = fs.existsSync('/tmp') ? '/tmp' : os.tmpDir()

var noop = function () {}

var sha1 = function (data) {
  return crypto.createHash('sha1').update(data).digest('hex')
}

var thruthy = function () {
  return true
}

var falsy = function () {
  return false
}

var toNumber = function (val) {
  return val === true ? 1 : (val || 0)
}

var torrentStream = function (link, opts, cb) {
  if (typeof opts === 'function') return torrentStream(link, null, opts)

  link = parseTorrent(link)
  var metadata = link.infoBuffer || null
  var infoHash = link.infoHash

  if (!opts) opts = {}
  if (!opts.id) opts.id = '-TS0008-' + hat(48)
  if (!opts.tmp) opts.tmp = TMP
  if (!opts.name) opts.name = 'torrent-stream'
  if (!opts.flood) opts.flood = 0 // Pulse defaults:
  if (!opts.pulse) opts.pulse = Number.MAX_SAFE_INTEGER // Do not pulse

  var usingTmp = false
  var destroyed = false

  if (!opts.path) {
    usingTmp = true
    opts.path = path.join(opts.tmp, opts.name, infoHash)
  }

  var engine = new events.EventEmitter()
  var swarm = pws(infoHash, opts.id, { size: (opts.connections || opts.size), speed: 10 })
  var torrentPath = path.join(opts.tmp, opts.name, infoHash + '.torrent')

  if (cb) engine.on('ready', cb.bind(null, engine))

  engine.ready = function (cb) {
    if (engine.torrent) cb()
    else engine.once('ready', cb)
  }

  var wires = swarm.wires
  var critical = []
  var refresh = noop

  var rechokeSlots = (opts.uploads === false || opts.uploads === 0) ? 0 : (+opts.uploads || 10)
  var rechokeOptimistic = null
  var rechokeOptimisticTime = 0
  var rechokeIntervalId

  engine.infoHash = infoHash
  engine.metadata = metadata
  engine.path = opts.path
  engine.files = []
  engine.selection = []
  engine.torrent = null
  engine.bitfield = null
  engine.amInterested = false
  engine.store = null
  engine.swarm = swarm
  engine._flood = opts.flood
  engine._pulse = opts.pulse

  var discovery = peerDiscovery({
    peerId: bufferFrom(opts.id),
    dht: (opts.dht !== undefined) ? opts.dht : true,
    tracker: (opts.tracker !== undefined) ? opts.tracker : true,
    port: DEFAULT_PORT,
    announce: opts.trackers
  })
  var blocked = blocklist(opts.blocklist)

  discovery.on('peer', function (addr) {
    if (blocked.contains(addr.split(':')[0])) {
      engine.emit('blocked-peer', addr)
    } else {
      engine.emit('peer', addr)
      engine.connect(addr)
    }
  })

  var ontorrent = function (torrent) {
    var storage = opts.storage || FSChunkStore
    engine.store = ImmediateChunkStore(storage(torrent.pieceLength, {
      files: torrent.files.map(function (file) {
        return {
          path: path.join(opts.path, file.path),
          length: file.length,
          offset: file.offset
        }
      })
    }))
    engine.torrent = torrent
    engine.bitfield = bitfield(torrent.pieces.length)

    var pieceLength = torrent.pieceLength
    var pieceRemainder = (torrent.length % pieceLength) || pieceLength

    var pieces = torrent.pieces.map(function (hash, i) {
      return piece(i === torrent.pieces.length - 1 ? pieceRemainder : pieceLength)
    })
    var reservations = torrent.pieces.map(function () {
      return []
    })

    process.nextTick(function () {
      // Gives the user a chance to call engine.listen(PORT) on the same tick,
      // so discovery will start using the correct torrent port.
      discovery.setTorrent(torrent)
    })

    engine.files = torrent.files.map(function (file) {
      file = Object.create(file)
      var offsetPiece = (file.offset / torrent.pieceLength) | 0
      var endPiece = ((file.offset + file.length - 1) / torrent.pieceLength) | 0

      file.deselect = function () {
        engine.deselect(offsetPiece, endPiece, false)
      }

      file.select = function () {
        engine.select(offsetPiece, endPiece, false)
      }

      file.createReadStream = function (opts) {
        var stream = fileStream(engine, file, opts)

        var notify = stream.notify.bind(stream)
        engine.select(stream.startPiece, stream.endPiece, true, notify)
        eos(stream, function () {
          engine.deselect(stream.startPiece, stream.endPiece, true, notify)
        })

        return stream
      }

      return file
    })

    var oninterestchange = function () {
      var prev = engine.amInterested
      engine.amInterested = !!engine.selection.length

      wires.forEach(function (wire) {
        if (engine.amInterested) wire.interested()
        else wire.uninterested()
      })

      if (prev === engine.amInterested) return
      if (engine.amInterested) engine.emit('interested')
      else engine.emit('uninterested')
    }

    var gc = function () {
      for (var i = 0; i < engine.selection.length; i++) {
        var s = engine.selection[i]
        var oldOffset = s.offset

        while (!pieces[s.from + s.offset] && s.from + s.offset < s.to) s.offset++

        if (oldOffset !== s.offset) s.notify()
        if (s.to !== s.from + s.offset) continue
        if (pieces[s.from + s.offset]) continue

        engine.selection.splice(i, 1)
        i-- // -1 to offset splice
        s.notify()
        oninterestchange()
      }

      if (!engine.selection.length) engine.emit('idle')
    }

    var onpiececomplete = function (index, buffer) {
      if (!pieces[index]) return

      pieces[index] = null
      reservations[index] = null
      engine.bitfield.set(index, true)

      for (var i = 0; i < wires.length; i++) wires[i].have(index)

      engine.emit('verify', index)
      engine.emit('download', index, buffer)

      engine.store.put(index, buffer)
      gc()
    }

    var onhotswap = opts.hotswap === false ? falsy : function (wire, index) {
      var speed = wire.downloadSpeed()
      if (speed < piece.BLOCK_LENGTH) return
      if (!reservations[index] || !pieces[index]) return

      var r = reservations[index]
      var minSpeed = Infinity
      var min

      for (var i = 0; i < r.length; i++) {
        var other = r[i]
        if (!other || other === wire) continue

        var otherSpeed = other.downloadSpeed()
        if (otherSpeed >= SPEED_THRESHOLD) continue
        if (2 * otherSpeed > speed || otherSpeed > minSpeed) continue

        min = other
        minSpeed = otherSpeed
      }

      if (!min) return false

      for (i = 0; i < r.length; i++) {
        if (r[i] === min) r[i] = null
      }

      for (i = 0; i < min.requests.length; i++) {
        var req = min.requests[i]
        if (req.piece !== index) continue
        pieces[index].cancel((req.offset / piece.BLOCK_SIZE) | 0)
      }

      engine.emit('hotswap', min, wire, index)
      return true
    }

    var onupdatetick = function () {
      process.nextTick(onupdate)
    }

    var onrequest = function (wire, index, hotswap) {
      if (!pieces[index]) return false

      var p = pieces[index]
      var reservation = p.reserve()

      if (reservation === -1 && hotswap && onhotswap(wire, index)) reservation = p.reserve()
      if (reservation === -1) return false

      var r = reservations[index] || []
      var offset = p.chunkOffset(reservation)
      var size = p.chunkLength(reservation)

      var i = r.indexOf(null)
      if (i === -1) i = r.length
      r[i] = wire

      wire.request(index, offset, size, function (err, block) {
        if (r[i] === wire) r[i] = null

        if (p !== pieces[index]) return onupdatetick()

        if (err) {
          p.cancel(reservation)
          onupdatetick()
          return
        }

        if (!p.set(reservation, block, wire)) return onupdatetick()

        var sources = p.sources
        var buffer = p.flush()

        if (sha1(buffer) !== torrent.pieces[index]) {
          pieces[index] = piece(p.length)
          engine.emit('invalid-piece', index, buffer)
          onupdatetick()

          sources.forEach(function (wire) {
            var now = Date.now()

            wire.badPieceStrikes = wire.badPieceStrikes.filter(function (strike) {
              return (now - strike) < BAD_PIECE_STRIKES_DURATION
            })

            wire.badPieceStrikes.push(now)

            if (wire.badPieceStrikes.length > BAD_PIECE_STRIKES_MAX) {
              engine.block(wire.peerAddress)
            }
          })

          return
        }

        onpiececomplete(index, buffer)
        onupdatetick()
      })

      return true
    }

    var onvalidatewire = function (wire) {
      if (wire.requests.length) return

      for (var i = engine.selection.length - 1; i >= 0; i--) {
        var next = engine.selection[i]
        for (var j = next.to; j >= next.from + next.offset; j--) {
          if (!wire.peerPieces[j]) continue
          if (onrequest(wire, j, false)) return
        }
      }
    }

    var speedRanker = function (wire) {
      var speed = wire.downloadSpeed() || 1
      if (speed > SPEED_THRESHOLD) return thruthy

      var secs = MAX_REQUESTS * piece.BLOCK_LENGTH / speed
      var tries = 10
      var ptr = 0

      return function (index) {
        if (!tries || !pieces[index]) return true

        var missing = pieces[index].missing
        for (; ptr < wires.length; ptr++) {
          var other = wires[ptr]
          var otherSpeed = other.downloadSpeed()

          if (otherSpeed < SPEED_THRESHOLD) continue
          if (otherSpeed <= speed || !other.peerPieces[index]) continue
          if ((missing -= otherSpeed * secs) > 0) continue

          tries--
          return false
        }

        return true
      }
    }

    var shufflePriority = function (i) {
      var last = i
      for (var j = i; j < engine.selection.length && engine.selection[j].priority; j++) {
        last = j
      }
      var tmp = engine.selection[i]
      engine.selection[i] = engine.selection[last]
      engine.selection[last] = tmp
    }

    var select = function (wire, hotswap) {
      if (wire.requests.length >= MAX_REQUESTS) return true

      // Pulse, or flood (default)
      if (swarm.downloaded > engine._flood && swarm.downloadSpeed() > engine._pulse) {
        return true
      }

      var rank = speedRanker(wire)

      for (var i = 0; i < engine.selection.length; i++) {
        var next = engine.selection[i]
        for (var j = next.from + next.offset; j <= next.to; j++) {
          if (!wire.peerPieces[j] || !rank(j)) continue
          while (wire.requests.length < MAX_REQUESTS && onrequest(wire, j, critical[j] || hotswap)) {}
          if (wire.requests.length < MAX_REQUESTS) continue
          if (next.priority) shufflePriority(i)
          return true
        }
      }

      return false
    }

    var onupdatewire = function (wire) {
      if (wire.peerChoking) return
      if (!wire.downloaded) return onvalidatewire(wire)
      select(wire, false) || select(wire, true)
    }

    var onupdate = function () {
      wires.forEach(onupdatewire)
    }

    var onwire = function (wire) {
      wire.setTimeout(opts.timeout || REQUEST_TIMEOUT, function () {
        engine.emit('timeout', wire)
        wire.destroy()
      })

      if (engine.selection.length) wire.interested()

      var timeout = CHOKE_TIMEOUT
      var id

      var onchoketimeout = function () {
        if (swarm.queued > 2 * (swarm.size - swarm.wires.length) && wire.amInterested) return wire.destroy()
        id = setTimeout(onchoketimeout, timeout)
      }

      wire.on('close', function () {
        clearTimeout(id)
      })

      wire.on('choke', function () {
        clearTimeout(id)
        id = setTimeout(onchoketimeout, timeout)
      })

      wire.on('unchoke', function () {
        clearTimeout(id)
      })

      wire.on('request', function (index, offset, length, cb) {
        if (pieces[index]) return
        engine.store.get(index, { offset: offset, length: length }, function (err, buffer) {
          if (err) return cb(err)
          engine.emit('upload', index, offset, length)
          cb(null, buffer)
        })
      })

      wire.on('unchoke', onupdate)
      wire.on('bitfield', onupdate)
      wire.on('have', onupdate)

      wire.isSeeder = false

      var i = 0
      var checkseeder = function () {
        if (wire.peerPieces.length !== torrent.pieces.length) return
        for (; i < torrent.pieces.length; ++i) {
          if (!wire.peerPieces[i]) return
        }
        wire.isSeeder = true
      }

      wire.on('bitfield', checkseeder)
      wire.on('have', checkseeder)
      checkseeder()

      wire.badPieceStrikes = []

      id = setTimeout(onchoketimeout, timeout)
    }

    var rechokeSort = function (a, b) {
      // Prefer higher download speed
      if (a.downSpeed !== b.downSpeed) return a.downSpeed > b.downSpeed ? -1 : 1
      // Prefer higher upload speed
      if (a.upSpeed !== b.upSpeed) return a.upSpeed > b.upSpeed ? -1 : 1
      // Prefer unchoked
      if (a.wasChoked !== b.wasChoked) return a.wasChoked ? 1 : -1
      // Random order
      return a.salt - b.salt
    }

    var onrechoke = function () {
      if (rechokeOptimisticTime > 0) --rechokeOptimisticTime
      else rechokeOptimistic = null

      var peers = []

      wires.forEach(function (wire) {
        if (wire.isSeeder) {
          if (!wire.amChoking) wire.choke()
        } else if (wire !== rechokeOptimistic) {
          peers.push({
            wire: wire,
            downSpeed: wire.downloadSpeed(),
            upSpeed: wire.uploadSpeed(),
            salt: Math.random(),
            interested: wire.peerInterested,
            wasChoked: wire.amChoking,
            isChoked: true
          })
        }
      })

      peers.sort(rechokeSort)

      var i = 0
      var unchokeInterested = 0
      for (; i < peers.length && unchokeInterested < rechokeSlots; ++i) {
        peers[i].isChoked = false
        if (peers[i].interested) ++unchokeInterested
      }

      if (!rechokeOptimistic && i < peers.length && rechokeSlots) {
        var candidates = peers.slice(i).filter(function (peer) { return peer.interested })
        var optimistic = candidates[(Math.random() * candidates.length) | 0]

        if (optimistic) {
          optimistic.isChoked = false
          rechokeOptimistic = optimistic.wire
          rechokeOptimisticTime = RECHOKE_OPTIMISTIC_DURATION
        }
      }

      peers.forEach(function (peer) {
        if (peer.wasChoked !== peer.isChoked) {
          if (peer.isChoked) peer.wire.choke()
          else peer.wire.unchoke()
        }
      })
    }

    var onready = function () {
      swarm.on('wire', onwire)
      swarm.wires.forEach(onwire)

      refresh = function () {
        process.nextTick(gc)
        oninterestchange()
        onupdate()
      }

      rechokeIntervalId = setInterval(onrechoke, RECHOKE_INTERVAL)

      process.nextTick(function () {
        engine.emit('torrent', torrent)
        engine.emit('ready')
        refresh()
      })
    }

    if (opts.verify === false) return onready()

    engine.emit('verifying')

    var loop = function (i) {
      if (i >= torrent.pieces.length) return onready()
      engine.store.get(i, function (_, buf) {
        if (!buf || sha1(buf) !== torrent.pieces[i] || !pieces[i]) return loop(i + 1)
        pieces[i] = null
        engine.bitfield.set(i, true)
        engine.emit('verify', i)
        loop(i + 1)
      })
    }

    loop(0)
  }

  var exchange = exchangeMetadata(engine, function (metadata) {
    var buf = bncode.encode({
      info: bncode.decode(metadata),
      'announce-list': []
    })

    ontorrent(parseTorrent(buf))

    mkdirp(path.dirname(torrentPath), function (err) {
      if (err) return engine.emit('error', err)
      fs.writeFile(torrentPath, buf, function (err) {
        if (err) engine.emit('error', err)
      })
    })
  })

  swarm.on('wire', function (wire) {
    engine.emit('wire', wire)
    exchange(wire)
    if (engine.bitfield) wire.bitfield(engine.bitfield)
  })

  swarm.pause()

  if (link.files && engine.metadata) {
    swarm.resume()
    ontorrent(link)
  } else {
    fs.readFile(torrentPath, function (_, buf) {
      if (destroyed) return
      swarm.resume()

      // We know only infoHash here, not full infoDictionary.
      // But infoHash is enough to connect to trackers and get peers.
      if (!buf) return discovery.setTorrent(link)

      var torrent = parseTorrent(buf)

      // Bad cache file - fetch it again
      if (torrent.infoHash !== infoHash) return discovery.setTorrent(link)

      if (!torrent.announce || !torrent.announce.length) {
        opts.trackers = [].concat(opts.trackers || []).concat(link.announce || [])
      }

      engine.metadata = torrent.infoBuffer
      ontorrent(torrent)
    })
  }

  engine.critical = function (piece, width) {
    for (var i = 0; i < (width || 1); i++) critical[piece + i] = true
  }

  engine.select = function (from, to, priority, notify) {
    engine.selection.push({
      from: from,
      to: to,
      offset: 0,
      priority: toNumber(priority),
      notify: notify || noop
    })

    engine.selection.sort(function (a, b) {
      return b.priority - a.priority
    })

    refresh()
  }

  engine.deselect = function (from, to, priority, notify) {
    notify = notify || noop
    for (var i = 0; i < engine.selection.length; i++) {
      var s = engine.selection[i]
      if (s.from !== from || s.to !== to) continue
      if (s.priority !== toNumber(priority)) continue
      if (s.notify !== notify) continue
      engine.selection.splice(i, 1)
      i--
      break
    }

    refresh()
  }

  engine.setPulse = function (bps) {
    // Set minimum byte/second pulse starting now (dynamic)
    // Eg. Start pulsing at minimum 312 KBps:
    // engine.setPulse(312*1024)

    engine._pulse = bps
  }

  engine.setFlood = function (b) {
    // Set bytes to flood starting now (dynamic)
    // Eg. Start flooding for next 10 MB:
    // engine.setFlood(10*1024*1024)

    engine._flood = b + swarm.downloaded
  }

  engine.setFloodedPulse = function (b, bps) {
    // Set bytes to flood before starting a minimum byte/second pulse (dynamic)
    // Eg. Start flooding for next 10 MB, then start pulsing at minimum 312 KBps:
    // engine.setFloodedPulse(10*1024*1024, 312*1024)

    engine.setFlood(b)
    engine.setPulse(bps)
  }

  engine.flood = function () {
    // Reset flood/pulse values to default (dynamic)
    // Eg. Flood the network starting now:
    // engine.flood()

    engine._flood = 0
    engine._pulse = Number.MAX_SAFE_INTEGER
  }

  engine.connect = function (addr) {
    swarm.add(addr)
  }

  engine.disconnect = function (addr) {
    swarm.remove(addr)
  }

  engine.block = function (addr) {
    blocked.add(addr.split(':')[0])
    engine.disconnect(addr)
    engine.emit('blocking', addr)
  }

  var removeTorrent = function (cb) {
    fs.unlink(torrentPath, function (err) {
      if (err) return cb(err)
      fs.rmdir(path.dirname(torrentPath), function (err) {
        if (err && err.code !== 'ENOTEMPTY') return cb(err)
        cb()
      })
    })
  }

  var removeTmp = function (cb) {
    if (!usingTmp) return removeTorrent(cb)
    rimraf(opts.path, function (err) {
      if (err) return cb(err)
      removeTorrent(cb)
    })
  }

  engine.remove = function (keepPieces, cb) {
    if (typeof keepPieces === 'function') {
      cb = keepPieces
      keepPieces = false
    }

    if (keepPieces || !engine.store || !engine.store.destroy) return removeTmp(cb)

    engine.store.destroy(function (err) {
      if (err) return cb(err)
      removeTmp(cb)
    })
  }

  engine.destroy = function (cb) {
    destroyed = true
    swarm.destroy()
    clearInterval(rechokeIntervalId)
    discovery.stop()
    if (engine.store && engine.store.close) {
      engine.store.close(cb)
    } else if (cb) {
      process.nextTick(cb)
    }
  }

  var findPort = function (def, cb) {
    var net = require('net')
    var s = net.createServer()

    s.on('error', function () {
      findPort(0, cb)
    })

    s.listen(def, function () {
      var port = s.address().port
      s.close(function () {
        engine.listen(port, cb)
      })
    })
  }

  engine.listen = function (port, cb) {
    if (typeof port === 'function') return engine.listen(0, port)
    if (!port) return findPort(opts.port || DEFAULT_PORT, cb)
    engine.port = port
    swarm.listen(engine.port, cb)
    discovery.updatePort(engine.port)
  }

  return engine
}

module.exports = torrentStream
