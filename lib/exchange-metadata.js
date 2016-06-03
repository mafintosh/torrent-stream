(function (global, factory) {
  if (typeof define === "function" && define.amd) {
    define(['module', 'exports', 'bncode', 'crypto'], factory);
  } else if (typeof exports !== "undefined") {
    factory(module, exports, require('bncode'), require('crypto'));
  } else {
    var mod = {
      exports: {}
    };
    factory(mod, mod.exports, global.bncode, global.crypto);
    global.exchangeMetadata = mod.exports;
  }
})(this, function (module, exports, _bncode, _crypto) {
  'use strict';

  Object.defineProperty(exports, "__esModule", {
    value: true
  });

  exports.default = function (engine, callback) {
    var metadataPieces = [];

    return function (wire) {
      var metadata = engine.metadata;
      wire.once('extended', function (id, handshake) {
        try {
          handshake = _bncode2.default.decode(handshake);
        } catch (err) {
          return;
        }

        if (id || !handshake.m || handshake.m.ut_metadata === undefined) return;

        var channel = handshake.m.ut_metadata;
        var size = handshake.metadata_size;

        wire.on('extended', function (id, ext) {
          if (id !== EXTENSIONS.m.ut_metadata) return;

          var metadata = engine.metadata;
          var delimiter, message, piece;
          try {
            delimiter = ext.toString('ascii').indexOf('ee');
            message = _bncode2.default.decode(ext.slice(0, delimiter === -1 ? ext.length : delimiter + 2));
            piece = message.piece;
          } catch (err) {
            return;
          }

          if (piece < 0) return;
          if (message.msg_type === 2) return;

          if (message.msg_type === 0) {
            if (!metadata) return wire.extended(channel, { msg_type: 2, piece: piece });
            var offset = piece * METADATA_BLOCK_SIZE;
            var buf = metadata.slice(offset, offset + METADATA_BLOCK_SIZE);
            wire.extended(channel, Buffer.concat([_bncode2.default.encode({ msg_type: 1, piece: piece }), buf]));
            return;
          }

          if (message.msg_type === 1 && !metadata) {
            metadataPieces[piece] = ext.slice(delimiter + 2);
            for (var i = 0; i * METADATA_BLOCK_SIZE < size; i++) {
              if (!metadataPieces[i]) return;
            }

            metadata = Buffer.concat(metadataPieces);

            if (engine.infoHash !== sha1(metadata)) {
              metadataPieces = [];
              metadata = null;
              return;
            }

            callback(engine.metadata = metadata);
          }
        });

        if (size > METADATA_MAX_SIZE) return;
        if (!size || metadata) return;

        for (var i = 0; i * METADATA_BLOCK_SIZE < size; i++) {
          if (metadataPieces[i]) continue;
          wire.extended(channel, { msg_type: 0, piece: i });
        }
      });

      if (!wire.peerExtensions.extended) return;
      wire.extended(0, metadata ? { m: { ut_metadata: 1 }, metadata_size: metadata.length } : { m: { ut_metadata: 1 } });
    };
  };

  var _bncode2 = _interopRequireDefault(_bncode);

  var _crypto2 = _interopRequireDefault(_crypto);

  function _interopRequireDefault(obj) {
    return obj && obj.__esModule ? obj : {
      default: obj
    };
  }

  var METADATA_BLOCK_SIZE = 1 << 14;
  var METADATA_MAX_SIZE = 1 << 22;
  var EXTENSIONS = {
    m: {
      ut_metadata: 1
    }
  };

  var sha1 = function sha1(data) {
    return _crypto2.default.createHash('sha1').update(data).digest('hex');
  };

  module.exports = exports['default'];
});