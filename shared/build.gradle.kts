import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Platform-independent WoVoice core consumed by the Android app and the desktop app.
// Compiled with the same Kotlin the AGP built-in compiler uses (2.2.10) so the app
// can consume its bytecode, and targeting JVM 11 to match the app's desugaring setup.
plugins {
    // AGP 9.3.1 embeds the Kotlin Gradle plugin (2.2.10) on the classpath, so this
    // must be applied unversioned; a pinned request cannot be version-checked.
    id("org.jetbrains.kotlin.jvm")
    alias(libs.plugins.ksp)
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_11)
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
}

// Export the Room schema so future migrations can be written and validated
// against real history instead of guesswork (schema v2 shipped unexported).
ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    api(libs.kotlinx.coroutines.core)
    // Android ships org.json on-device; the desktop app adds the Maven artifact itself.
    compileOnly(libs.org.json)
    api(libs.androidx.room.runtime)
    ksp(libs.androidx.room.compiler)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    // In-memory Room on the JVM for DAO tests; org.json is compileOnly above.
    testImplementation(libs.androidx.sqlite.bundled)
    testImplementation(libs.org.json)
}
