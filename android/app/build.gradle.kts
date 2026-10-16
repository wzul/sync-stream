import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Where this build points by default. Set it for your own build:
//   ./gradlew assembleRelease -PstreamUrl=https://your-host
val streamUrl = (project.findProperty("streamUrl") as String?) ?: "https://example.com"

val keystoreFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystoreFile.exists()) keystoreFile.inputStream().use { load(it) }
}

android {
    namespace = "asia.wzul.syncstream"
    compileSdk = 35

    defaultConfig {
        applicationId = "asia.wzul.syncstream"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "STREAM_URL", "\"$streamUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (keystoreProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile")!!)
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}
