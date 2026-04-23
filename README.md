# mesh-test

Two simple Node.js/TypeScript CLI apps for Meshtastic message flow:

- `producer`: creates a batch of UUID packets, pushes through queue + throttling + retry + circuit breaker.
- `consumer`: receives and prints packets from Meshtastic WS endpoint.

## Requirements

- Node.js 20+
- A Meshtastic WS endpoint (IP/device proxy)
- Windows PowerShell compatible scripts

## Install

```powershell
npm install
```

## Configure

```powershell
Copy-Item .env.example .env
```

Set endpoints in `.env`:

- `MESHTASTIC_PRODUCER_WS_URL` - WS endpoint for the device used by producer
- `MESHTASTIC_CONSUMER_WS_URL` - WS endpoint for the device used by consumer
- optional fallback `MESHTASTIC_WS_URL` (if both should use one endpoint)

## Run

Terminal 1:

```powershell
npm run consumer
```

Terminal 2:

```powershell
npm run producer
```

## Features

- In-memory broker queue (stack-like live view)
- Throttled send pipeline
- Retry with exponential backoff
- Circuit breaker (`closed/open/half-open`)
- Packet schema: `uuid`, `seq`, `createdAt`, `retries`, `status`, `channelMetrics`, `payload`
- Channel utilization shown if available in incoming/outgoing frames

## Validation checklist

- Producer sends full batch and marks statuses
- Consumer receives packets and prints parsed content
- Retry path works by stopping endpoint temporarily
- Circuit breaker opens after failure threshold and recovers
- Channel utilization is displayed when endpoint includes it