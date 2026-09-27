FROM --platform=linux/amd64 ubuntu:22.04
RUN apt-get update && apt-get install -y --no-install-recommends make file && rm -rf /var/lib/apt/lists/*
COPY eeenote-toolchain-amd64.deb /tmp/
RUN dpkg -x /tmp/eeenote-toolchain-amd64.deb / && rm /tmp/eeenote-toolchain-amd64.deb
ENV PATH=/opt/ea800-toolchain/bin:/usr/local/Trolltech/QtEmbedded-4.6.2-arm/bin:$PATH
WORKDIR /src
