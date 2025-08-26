# API Documentation

## Configuration

The server can be configured using environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port number |
| `DB_PATH` | `./data.db` | SQLite database file path |
| `CORS_ORIGIN` | `''` | CORS origin settings (empty string disables CORS) |
| `PUBLIC_DIR` | `./public` | Public directory for static files |
| `GROUP_MAP_PATH` | `<PUBLIC_DIR>/group-map.json` | Path to group mapping configuration |
| `NAME_KEYS_PATH` | `<PUBLIC_DIR>/name-keys.json` | Path to name-keys configuration |

## Authentication

The API uses Bearer token authentication for protected endpoints. The token must be included in the `Authorization` header:

```
Authorization: Bearer <your-token>
```

Authentication is validated against:
1. Machine whitelist in `group-map.json`
2. Personal tokens in `name-keys.json`

## Endpoints

### Health Check
```http
GET /api/health
```
Simple health check endpoint.

**Response:**
```json
{
  "ok": true
}
```

### Get Group Map
```http
GET /api/group-map
```
Returns the contents of the group-map.json file.

**Response:** JSON object containing group mappings

### Ingest Event
```http
POST /api/ingest
```
Reports a new desktop activity event.

**Authentication:** Required (Bearer token)

**Request Body:**
```json
{
  "machine": "string",       // or machine_id
  "window_title": "string",  // optional
  "app": "string",          // optional
  "event_time": "string",   // ISO datetime, optional (defaults to current time)
  "raw": "object"          // optional additional data
}
```

**Response:**
```json
{
  "ok": true
}
```

**Error Responses:**
- `400 Bad Request`: Missing machine ID or invalid event time
- `401 Unauthorized`: Missing or invalid token
- `403 Forbidden`: Machine not in whitelist

### Get Current Status
```http
GET /api/current-status
```
Retrieves recent activity events.

**Query Parameters:**
- `name` (optional): Filter by user name
- `machine` (optional): Filter by specific machine
- `limit` (optional): Maximum number of records to return (default: 50, max: 500)

**Examples:**
- `/api/current-status?name=username&limit=50` - Get events for all machines belonging to a user
- `/api/current-status?machine=machine-name` - Get events for a specific machine
- `/api/current-status` - Get events for all machines

**Response:**
```json
[
  {
    "machine": "string",
    "window_title": "string",
    "app": "string",
    "access_time": "string"
  }
]
```

### Get Latest Status
```http
GET /api/current-latest
```
Retrieves the most recent event for each machine.

**Response:**
```json
[
  {
    "machine": "string",
    "window_title": "string",
    "app": "string",
    "access_time": "string"
  }
]
```

## Configuration Files

### group-map.json
Defines machine groupings by user. Example structure:
```json
{
  "user1": ["machine1", "machine2"],
  "user2": ["machine3"]
}
```

### name-keys.json
Defines authentication tokens for users. Example structure:
```json
{
  "user1": ["token1", "token2"],
  "user2": ["token3"]
}
```

## Error Handling

All error responses follow the format:
```json
{
  "error": "Error message description"
}
```

Common error codes:
- `400`: Bad Request - Missing or invalid parameters
- `401`: Unauthorized - Missing or invalid authentication
- `403`: Forbidden - Machine not in whitelist
- `404`: Not Found - Endpoint doesn't exist

## Notes

- The server uses SQLite with WAL journal mode for data storage
- Maximum request body size is limited to 256KB
- CORS is configurable through environment variables
- Static files are served from the configured public directory
