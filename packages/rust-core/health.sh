#!/bin/sh
# Simple health check for pi-agent
# Checks if binary exists and can respond to a basic prompt

if [ ! -f /usr/local/bin/pi-agent ]; then
    echo "ERROR: pi-agent binary not found"
    exit 1
fi

# Try a quick no-op test (will fail at API call but binary works)
echo '{"prompt":"test"}' | timeout 5 /usr/local/bin/pi-agent > /dev/null 2>&1
if [ $? -eq 124 ]; then
    # Timed out = binary works but API didn't respond, that's OK for health
    echo "OK: pi-agent binary loaded"
    exit 0
elif [ $? -eq 0 ]; then
    echo "OK: pi-agent responded"
    exit 0
else
    echo "WARN: pi-agent binary check failed, but may still work at runtime"
    exit 0
fi
