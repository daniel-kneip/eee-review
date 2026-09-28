#!/bin/sh
# Starts eee-review on the Eee Note: the USB link to the Mac, then the app, which tries the
# hub through the cable first and over Wi-Fi after that (the address deploy left in hub-wifi).
#
# The gadget drivers exclude each other, and only g_serial in plain bulk mode works with a Mac:
# the Ethernet gadget offers nothing but RNDIS, and the ACM serial mode stalls macOS's driver.

DIR=/eTablet/eee-review
GADGETS=/lib/modules/2.6.21/kernel/drivers/usb/gadget
cd $DIR || exit 1

if ! pidof eeelink >/dev/null; then
  for g in g_ether g_file_storage g_wacom_tablet g_serial; do rmmod $g 2>/dev/null; done
  insmod $GADGETS/g_serial.ko use_acm=0
  ./eeelink > /tmp/eeelink.log 2>&1 &
fi

# The environment the stock apps run in (see /usr/local/eTablet/run.sh).
export QTDIR=/usr/local/Trolltech/QtEmbedded-4.6.2-arm
export LD_LIBRARY_PATH=/usr/local/eTablet/lib:/lib/ts:/usr/local/lib:/usr/lib:/lib:$QTDIR/lib
export QWS_DISPLAY=Transformed
export QWS_MOUSE_PROTO=Tslib:/dev/input/event2
export TSLIB_TSDEVICE=/dev/input/event2 TSLIB_CONFFILE=/etc/ts.conf TSLIB_PLUGINDIR=/lib/ts
export FONTCONFIG_PATH=/etc/fonts HOME=/eTablet

killall eeereview 2>/dev/null
HUBS="http://127.0.0.1:8770/ $(cat hub-wifi 2>/dev/null)"
# From the launcher the app has to stay this process, which the launcher watches.
if [ "$1" = foreground ]; then
  exec ./eeereview $HUBS > /tmp/eeereview.log 2>&1
fi
./eeereview $HUBS > /tmp/eeereview.log 2>&1 &
