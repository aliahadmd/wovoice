package com.aliahad.wovoice.core

import java.io.ByteArrayOutputStream

object Base64Url {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    fun encode(value: ByteArray): String {
        val output = StringBuilder((value.size * 4 + 2) / 3)
        var index = 0
        while (index < value.size) {
            val first = value[index++].toInt() and 0xff
            val second = if (index < value.size) value[index++].toInt() and 0xff else -1
            val third = if (index < value.size) value[index++].toInt() and 0xff else -1
            output.append(ALPHABET[first ushr 2])
            output.append(ALPHABET[((first and 3) shl 4) or if (second >= 0) second ushr 4 else 0])
            if (second >= 0) {
                output.append(ALPHABET[((second and 15) shl 2) or if (third >= 0) third ushr 6 else 0])
            }
            if (third >= 0) output.append(ALPHABET[third and 63])
        }
        return output.toString()
    }

    fun decode(value: String): ByteArray {
        require(value.length % 4 != 1 && value.all { ALPHABET.indexOf(it) >= 0 })
        val output = ByteArrayOutputStream(value.length * 3 / 4)
        var buffer = 0
        var bits = 0
        value.forEach { character ->
            buffer = (buffer shl 6) or ALPHABET.indexOf(character)
            bits += 6
            if (bits >= 8) {
                bits -= 8
                output.write((buffer shr bits) and 0xff)
            }
        }
        if (bits > 0) require((buffer and ((1 shl bits) - 1)) == 0)
        return output.toByteArray()
    }
}
