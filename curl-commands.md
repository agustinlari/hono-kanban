# Comandos CURL para probar Keycloak endpoints

## Variables
```bash
BASE_URL="https://aplicaciones.osmos.es:4444/api/kanban"
USERNAME="tu_usuario_keycloak"
PASSWORD="tu_password_keycloak"
```

## 1. LOGIN
```bash
curl -X POST "$BASE_URL/auth/keycloak/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" \
  | jq '.'
```

## 2. GET ME (usar el access_token del login)
```bash
ACCESS_TOKEN="token_obtenido_del_login"

curl -X GET "$BASE_URL/auth/keycloak/me" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  | jq '.'
```

## 3. GET BOARDS (endpoint protegido)
```bash
curl -X GET "$BASE_URL/boards" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  | jq '.'
```

## 4. REFRESH TOKEN
```bash
REFRESH_TOKEN="refresh_token_obtenido_del_login"

curl -X POST "$BASE_URL/auth/keycloak/refresh" \
  -H "Content-Type: application/json" \
  -d "{\"refresh_token\":\"$REFRESH_TOKEN\"}" \
  | jq '.'
```

## 5. LOGOUT
```bash
curl -X POST "$BASE_URL/auth/keycloak/logout" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{}" \
  | jq '.'
```

## Ejemplo completo paso a paso

1. **Hacer login y guardar respuesta:**
```bash
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/keycloak/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")
echo "$LOGIN_RESPONSE" | jq '.'
```

2. **Extraer access_token:**
```bash
ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.access_token')
echo "Token: $ACCESS_TOKEN"
```

3. **Usar el token para endpoints protegidos:**
```bash
curl -X GET "$BASE_URL/auth/keycloak/me" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq '.'
```

## Debugging adicional

### Ver headers de respuesta:
```bash
curl -i -X POST "$BASE_URL/auth/keycloak/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}"
```

### Ver tiempo de respuesta:
```bash
curl -w "@curl-format.txt" -X POST "$BASE_URL/auth/keycloak/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" \
  | jq '.'
```

Donde `curl-format.txt` contiene:
```
     time_namelookup:  %{time_namelookup}\n
        time_connect:  %{time_connect}\n
     time_appconnect:  %{time_appconnect}\n
    time_pretransfer:  %{time_pretransfer}\n
       time_redirect:  %{time_redirect}\n
  time_starttransfer:  %{time_starttransfer}\n
                     ----------\n
          time_total:  %{time_total}\n
```