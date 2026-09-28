#!/bin/sh
# The launcher's entry for eee-review: it starts /usr/local/eTablet/bin/eeereview/eeereview,
# which is this script, and tracks the process until the app exits.
exec /eTablet/eee-review/start.sh foreground
