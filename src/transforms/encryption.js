const { PassThrough, Transform } = require('readable-stream')
const crypto = require('crypto')
const aesjs = require('aes-js')
const Zlib = require('zlib')

const CIPHER = 'aes-256-cfb8'

function createCipher(secret, initialValue) {
  if (crypto.getCiphers().includes(CIPHER)) {
    return crypto.createCipheriv(CIPHER, secret, initialValue)
  }
  return new Cipher(secret, initialValue)
}

function createDecipher(secret, initialValue) {
  if (crypto.getCiphers().includes(CIPHER)) {
    return crypto.createDecipheriv(CIPHER, secret, initialValue)
  }
  return new Decipher(secret, initialValue)
}

class Cipher extends Transform {
  constructor(secret, iv) {
    super()
    this.aes = new aesjs.ModeOfOperation.cfb(secret, iv, 1) // eslint-disable-line new-cap
  }

  _transform(chunk, enc, cb) {
    try {
      const res = this.aes.encrypt(chunk)
      cb(null, res)
    } catch (e) {
      cb(e)
    }
  }
}

class Decipher extends Transform {
  constructor(secret, iv) {
    super()
    this.aes = new aesjs.ModeOfOperation.cfb(secret, iv, 1) // eslint-disable-line new-cap
  }

  _transform(chunk, enc, cb) {
    try {
      const res = this.aes.decrypt(chunk)
      cb(null, res)
    } catch (e) {
      cb(e)
    }
  }
}

function computeCheckSum(packetPlaintext, sendCounter, secretKeyBytes) {
  let digest = crypto.createHash('sha256');
  let counter = Buffer.alloc(8)
  // writeLI64(sendCounter, counter, 0);
  counter.writeBigInt64LE(sendCounter, 0)
  // console.log('Send counter', counter)
  digest.update(counter);
  digest.update(packetPlaintext);
  digest.update(secretKeyBytes);
  let hash = digest.digest();

  return hash.slice(0, 8);
}

function createEncryptor(client, iv) {
  client.cipher = createCipher(client.secretKeyBytes, iv)
  client.sendCounter = client.sendCounter || 0n

  // A packet is encrypted via AES256(plaintext + SHA256(send_counter + plaintext + secret_key)[0:8]).
  // The send counter is represented as a little-endian 64-bit long and incremented after each packet.

  const addChecksum = new Transform({ // append checksum
    transform(chunk, enc, cb) {
      console.log('Encryptor: checking checksum', chunk)
      // Here we concat the payload + checksum before the encryption
      const packet = Buffer.concat([chunk, computeCheckSum(chunk, client.sendCounter, client.secretKeyBytes)])
      client.sendCounter++
      this.push(packet)
      cb()
    }
  })

  // https://stackoverflow.com/q/25971715/11173996
  // TODO: Fix deflate stream - for some reason using .pipe() doesn't work using zlib.createDeflateRaw()
  // so we define our own compressor transform
  // const compressor = Zlib.createDeflateRaw({ level: 7, chunkSize: 1024 * 1024 * 2, flush: Zlib.Z_SYNC_FLUSH })
  const compressor = new Transform({
    transform(chunk, enc, cb) {
      Zlib.deflateRaw(chunk, { level: 7 }, (err, res) => {
        if (err) {
          console.error(err)
          throw new Error(`Failed to deflate stream`)
        }
        this.push(res)
        cb()
      })
    }
  })


  const stream = new PassThrough()

  stream
    .pipe(compressor)
    .pipe(addChecksum).pipe(client.cipher).on('data', client.onEncryptedPacket)

  return (blob) => {
    stream.write(blob)
  }
}


function createDecryptor(client, iv) {
  client.decipher = createDecipher(client.secretKeyBytes, iv)
  client.receiveCounter = client.receiveCounter || 0n

  const verifyChecksum = new Transform({ // verify checksum
    transform(chunk, encoding, cb) {
      console.log('Decryptor: checking checksum', chunk)
      const packet = chunk.slice(0, chunk.length - 8);
      const checksum = chunk.slice(chunk.length - 8);
      const computedCheckSum = computeCheckSum(packet, client.receiveCounter, client.secretKeyBytes)
      console.assert(checksum.toString("hex") == computedCheckSum.toString("hex"), 'checksum mismatch')
      client.receiveCounter++
      if (checksum.toString("hex") == computedCheckSum.toString("hex")) {
        this.push(packet)
      } else {
        throw Error(`Checksum mismatch ${checksum.toString("hex")} != ${computedCheckSum.toString("hex")}`)
      }
      cb()
    }
  })

  const inflator = new Transform({
    transform(chunk, enc, cb) {
      Zlib.inflateRaw(chunk, { chunkSize: 1024 * 1024 * 2 }, (err, buf) => {
        if (err) throw err
        this.push(buf)
        cb()
      })
    }
  })

  client.decipher.pipe(verifyChecksum)
    .pipe(inflator)
    // .pipe(Zlib.createInflateRaw({ chunkSize: 1024 * 1024 * 2 }))
    .on('data', (...args) => client.onDecryptedPacket(...args))
    .on('end', () => console.log('Decryptor: finish pipeline'))


  return (blob) => {
    client.decipher.write(blob)
  }
}

module.exports = {
  createCipher, createDecipher, createEncryptor, createDecryptor
}

function testDecrypt() {
  const client = {
    secretKeyBytes: Buffer.from('ZOBpyzki/M8UZv5tiBih048eYOBVPkQE3r5Fl0gmUP4=', 'base64'),
    onDecryptedPacket: (...data) => console.log('Decrypted', data)
  }
  const iv = Buffer.from('ZOBpyzki/M8UZv5tiBih0w==', 'base64')

  const decrypt = createDecryptor(client, iv)
  console.log('Dec', decrypt(Buffer.from('4B4FCA0C2A4114155D67F8092154AAA5EF', 'hex')))
  console.log('Dec 2', decrypt(Buffer.from('DF53B9764DB48252FA1AE3AEE4', 'hex')))
}

// testDecrypt()