#!/bin/bash

# Script de prueba para endpoints de Keycloak
# Configura estas variables según tu setup

BASE_URL="https://aplicaciones.osmos.es:4444/api/kanban"
USERNAME="tu_usuario_keycloak"
PASSWORD="tu_password_keycloak"

echo "🔐 === PRUEBAS KEYCLOAK AUTHENTICATION ==="
echo "🔗 Base URL: $BASE_URL"
echo "👤 Usuario: $USERNAME"
echo

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# 1. TEST LOGIN
echo -e "${BLUE}📝 1. Probando LOGIN...${NC}"
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/keycloak/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")

echo "Respuesta completa:"
echo "$LOGIN_RESPONSE" | jq '.' 2>/dev/null || echo "$LOGIN_RESPONSE"

# Extraer access_token
ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.access_token' 2>/dev/null)

if [ "$ACCESS_TOKEN" != "null" ] && [ ! -z "$ACCESS_TOKEN" ]; then
    echo -e "${GREEN}✅ LOGIN exitoso - Token obtenido${NC}"
    echo "Token (primeros 50 chars): ${ACCESS_TOKEN:0:50}..."
else
    echo -e "${RED}❌ LOGIN falló - No se obtuvo token${NC}"
    exit 1
fi

echo
echo "=================================================="
echo

# 2. TEST GET /ME
echo -e "${BLUE}👤 2. Probando GET /me...${NC}"
ME_RESPONSE=$(curl -s -X GET "$BASE_URL/auth/keycloak/me" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

echo "Respuesta /me:"
echo "$ME_RESPONSE" | jq '.' 2>/dev/null || echo "$ME_RESPONSE"

# Verificar si contiene información del usuario
if echo "$ME_RESPONSE" | jq -e '.user' > /dev/null 2>&1; then
    echo -e "${GREEN}✅ GET /me exitoso${NC}"
    USER_EMAIL=$(echo "$ME_RESPONSE" | jq -r '.user.email' 2>/dev/null)
    USER_NAME=$(echo "$ME_RESPONSE" | jq -r '.user.name' 2>/dev/null)
    echo "Email: $USER_EMAIL"
    echo "Nombre: $USER_NAME"
else
    echo -e "${RED}❌ GET /me falló${NC}"
fi

echo
echo "=================================================="
echo

# 3. TEST BOARDS (endpoint protegido con el token)
echo -e "${BLUE}📋 3. Probando GET /boards (endpoint protegido)...${NC}"
BOARDS_RESPONSE=$(curl -s -X GET "$BASE_URL/boards" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

echo "Respuesta boards:"
echo "$BOARDS_RESPONSE" | jq '.' 2>/dev/null || echo "$BOARDS_RESPONSE"

if echo "$BOARDS_RESPONSE" | jq -e 'type == "array"' > /dev/null 2>&1; then
    echo -e "${GREEN}✅ GET /boards exitoso${NC}"
    BOARDS_COUNT=$(echo "$BOARDS_RESPONSE" | jq 'length' 2>/dev/null)
    echo "Número de boards: $BOARDS_COUNT"
else
    echo -e "${YELLOW}⚠️  GET /boards puede haber fallado o devuelto formato inesperado${NC}"
fi

echo
echo "=================================================="
echo

# 4. TEST REFRESH TOKEN (si está disponible en el login response)
REFRESH_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.refresh_token' 2>/dev/null)

if [ "$REFRESH_TOKEN" != "null" ] && [ ! -z "$REFRESH_TOKEN" ]; then
    echo -e "${BLUE}🔄 4. Probando REFRESH TOKEN...${NC}"
    
    REFRESH_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/keycloak/refresh" \
      -H "Content-Type: application/json" \
      -d "{\"refresh_token\":\"$REFRESH_TOKEN\"}")
    
    echo "Respuesta refresh:"
    echo "$REFRESH_RESPONSE" | jq '.' 2>/dev/null || echo "$REFRESH_RESPONSE"
    
    NEW_ACCESS_TOKEN=$(echo "$REFRESH_RESPONSE" | jq -r '.access_token' 2>/dev/null)
    
    if [ "$NEW_ACCESS_TOKEN" != "null" ] && [ ! -z "$NEW_ACCESS_TOKEN" ]; then
        echo -e "${GREEN}✅ REFRESH TOKEN exitoso${NC}"
        echo "Nuevo token (primeros 50 chars): ${NEW_ACCESS_TOKEN:0:50}..."
    else
        echo -e "${RED}❌ REFRESH TOKEN falló${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  No hay refresh_token disponible para probar${NC}"
fi

echo
echo "=================================================="
echo

# 5. TEST LOGOUT
echo -e "${BLUE}🚪 5. Probando LOGOUT...${NC}"
LOGOUT_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/keycloak/logout" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{}")

echo "Respuesta logout:"
echo "$LOGOUT_RESPONSE" | jq '.' 2>/dev/null || echo "$LOGOUT_RESPONSE"

if echo "$LOGOUT_RESPONSE" | jq -e '.success' > /dev/null 2>&1; then
    echo -e "${GREEN}✅ LOGOUT exitoso${NC}"
else
    echo -e "${YELLOW}⚠️  LOGOUT puede haber fallado o devuelto formato inesperado${NC}"
fi

echo
echo "🏁 === PRUEBAS COMPLETADAS ==="