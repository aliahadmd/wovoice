import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    // AGP 9.3.1 embeds the Kotlin Gradle plugin (2.2.10) on the classpath, so the
    // Kotlin plugin itself is applied unversioned. The compose-compiler plugin is
    // NOT on AGP's classpath and must be pinned to the same Kotlin version.
    id("org.jetbrains.kotlin.jvm")
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.compose.multiplatform)
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
    }
}

dependencies {
    implementation(project(":shared"))
    implementation(compose.desktop.currentOs)
    implementation(compose.material3)
    implementation(libs.kotlinx.coroutines.swing)
    implementation(libs.org.json)
    implementation(libs.jna)
}

compose.desktop {
    application {
        mainClass = "com.aliahad.wovoice.desktop.MainKt"

        nativeDistributions {
            targetFormats(TargetFormat.Dmg, TargetFormat.AppImage)
            packageName = "WoVoice"
            packageVersion = "1.0.0"
            vendor = "Ali Ahad"
            description = "WoVoice speech-first dictation for macOS"
            macOS {
                bundleID = "com.aliahad.wovoice.desktop"
                // Without this key macOS silently delivers all-zero mic audio
                // instead of showing the permission prompt.
                infoPlist {
                    extraKeysRawXml = """
                        <key>NSMicrophoneUsageDescription</key>
                        <string>WoVoice needs microphone access to convert your speech into text.</string>
                    """.trimIndent()
                }
                // Ad-hoc local signing until a Developer ID is configured.
                signing {
                    sign.set(false)
                }
            }
        }
    }
}
