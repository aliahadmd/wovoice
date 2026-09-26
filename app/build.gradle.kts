plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.aliahad.wovoice"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.aliahad.wovoice"
        minSdk = 24
        targetSdk = 36
        versionCode = 8
        versionName = "1.6.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    val releaseKeystorePath = providers.environmentVariable("WOVOICE_KEYSTORE_PATH").orNull
    if (!releaseKeystorePath.isNullOrBlank()) {
        signingConfigs {
            create("release") {
                storeFile = file(releaseKeystorePath)
                storePassword = providers.environmentVariable("WOVOICE_STORE_PASSWORD").get()
                keyAlias = providers.environmentVariable("WOVOICE_KEY_ALIAS").get()
                keyPassword = providers.environmentVariable("WOVOICE_KEY_PASSWORD").get()
            }
        }
    }

    buildTypes {
        debug {
            buildConfigField("String", "WOVOICE_BASE_URL", "\"https://wovoice.aliahad.com\"")
            buildConfigField("boolean", "ALLOW_CUSTOM_ENDPOINT", "true")
            manifestPlaceholders["authHost"] = "wovoice.aliahad.com"
        }
        release {
            buildConfigField("String", "WOVOICE_BASE_URL", "\"https://wovoice.aliahad.com\"")
            buildConfigField("boolean", "ALLOW_CUSTOM_ENDPOINT", "false")
            manifestPlaceholders["authHost"] = "wovoice.aliahad.com"
            if (!releaseKeystorePath.isNullOrBlank()) {
                signingConfig = signingConfigs.getByName("release")
            }
            optimization {
                enable = true
            }
        }
    }
    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(project(":shared"))
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.core.ktx)
    implementation(libs.material)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.recyclerview)
    implementation(libs.androidx.browser)
    ksp(libs.androidx.room.compiler)
    coreLibraryDesugaring(libs.desugar.jdk.libs)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(libs.androidx.junit)
}
