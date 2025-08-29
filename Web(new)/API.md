# API Documentation

## Configuration

The server can be configured using environment variables:

| Variable                  | Default                       | Description                                              |
|---------------------------|-------------------------------|----------------------------------------------------------|
| `PORT`                    | 3000                          | Server port number                                       |
| `DB_PATH`                 | `./data.db`                   | SQLite database file path                                |
| `CORS_ORIGIN`             | `''`                          | CORS origin settings (empty string disables CORS)        |
| `PUBLIC_DIR`              | `./public`                    | Public directory for static files                        |
| `GROUP_MAP_PATH`          | `<PUBLIC_DIR>/group-map.json` | Path to group mapping configuration                      |
| `NAME_KEYS_PATH`          | `<PUBLIC_DIR>/name-keys.json` | Path to name-keys configuration                          |
| `MIN_VERSIONS_PATH`       | `<PUBLIC_DIR>/min-versions.json` | **New**: Local client minimum version configuration   |
| `CLEAN_MODE`              | `keep-one`                    | Data cleanup mode: `keep-one` or `wipe`                  |
| `CLEAR_HOUR`              | `3`                           | Cleanup hour (0-23)                                      |
| `CLEAR_MINUTE`            | `5`                           | Cleanup minute (0-59)                                    |
| `MAX_TITLE_LEN`           | `150`                         | Maximum window title length                              |
| `MIN_INGEST_INTERVAL_MS`  | `4000`                        | Minimum allowed ingest interval per machine (ms)         |
| `ONE_TIME_UPDATE_PROMPT_ENABLED` | `1` (on)              | **New**: One-time update prompt for clients              |
| `FIRST_PROMPT_DIR`        | `./first-prompt`              | **New**: Directory for first-prompt flags                |
| `APP_UPDATE_CHECK_ENABLED`| `1` (on)                      | **New**: Enable strict local client version check        |
| `DEBUG_UPDATE_CHECK`      | `0`                           | Debug log for update check                              |

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

### List All Names (**New**)
```http
GET /api/names
```
Returns all available user names (does not expose keys).

**Response:**
```json
{ "names": ["user1", "user2", ...] }
```

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
  "window_title": "string",  // optional, max length 150 (configurable)
  "app": "string",           // optional
  "event_time": "string",    // ISO datetime, optional (defaults to current time)
  "raw": "object",           // optional additional data, preserved
  "os": "string",            // client OS for version check
  "app_version": "string"    // client version for update check
}
```

**Response:**
```json
{
  "ok": true
}
```

**Special Responses:**
- `426 Upgrade Required` (code: `outdated_client`): If client version is outdated or first-time prompt is enabled, response will include upgrade prompt or version information.  

  Example responses:
    
  - When `os` is unspecified:
    ```json
    {
      "error":"outdated_client",
      "message":"Your monitor is outdated. Please update to the latest version.",
      "os":null
    }
    ```
  - When current is outdated, or `os` is specified, but `version` is unspecified:
    ```json
    {
      "error":"outdated_client",
      "message":"Your android app is outdated. Minimum required version is 1.5.0, but you are on 0.0.0. Please update.",
      "os":"android",
      "min_required_version":"1.5.0",
      "current_version":"0.0.0"
    }
    ```
    
  </details>
- `429 Too Many Requests`: If reports are too frequent for the same machine.
  
  Example response:
  
  ```json
  {
    "error":"Request too frequent, minimum interval is 4 seconds",
    "machine":"test-device",
    "min_interval_ms":4000,
    "elapsed_ms":3361,
    "retry_after_ms":639
  }
  ```

**Error Responses:**
- `400 Bad Request`: Missing machine ID, event time invalid, or window_title too long
- `401 Unauthorized`: Missing or invalid token
- `403 Forbidden`: Machine not in whitelist
- `426 Upgrade Required`: Outdated client, see above

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

### Get Latest Status Per Machine
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

### min-versions.json (**New**)
Defines minimum required versions per client OS. Example:
```json
{
  "windows": "0.2.0",
  "android": "0.2.0"
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
- `426`: Upgrade Required - Client needs update or first-prompt

## Notes

- The server uses SQLite with WAL journal mode for data storage.
- Maximum request body size is limited to 256KB.
- CORS is configurable through environment variables.
- Static files are served from the configured public directory.
- **New:** Data cleanup can be set to either "wipe all" or "keep only the latest event per machine", scheduled daily via CLEAN_MODE.
- **New:** Strict local client version check and one-time update notification are supported (see environment variables above).
