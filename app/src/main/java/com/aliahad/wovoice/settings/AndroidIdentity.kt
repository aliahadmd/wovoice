package com.aliahad.wovoice.settings

import android.os.Build

internal fun androidDeviceName(): String = listOf(Build.MANUFACTURER, Build.MODEL)
    .filter(String::isNotBlank)
    .joinToString(" ")
    .ifBlank { "Android device" }
    .take(80)
