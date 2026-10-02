# Образ для сборки Android-приложения: JDK 21 и Android SDK под версии из packages/mobile/android/variables.gradle.
# Инструменты SDK собраны под x86_64, поэтому образ всегда linux/amd64 (на Apple Silicon работает через Rosetta).
FROM --platform=linux/amd64 eclipse-temurin:21-jdk

RUN apt-get update && apt-get install -y --no-install-recommends unzip wget && rm -rf /var/lib/apt/lists/*

ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools

ARG CMDLINE_TOOLS=https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
RUN mkdir -p $ANDROID_HOME/cmdline-tools && cd $ANDROID_HOME/cmdline-tools \
  && wget -q "$CMDLINE_TOOLS" -O tools.zip && unzip -q tools.zip && rm tools.zip && mv cmdline-tools latest

RUN yes | sdkmanager --licenses >/dev/null \
  && sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "build-tools;35.0.0" >/dev/null

WORKDIR /work
