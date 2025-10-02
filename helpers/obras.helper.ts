// ================================
// src/helpers/obras.helper.ts 
// ================================

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database'; 
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';
import * as XLSX from 'xlsx';
import fs from 'fs/promises';
import path from 'path';
import { parse as parseCSV } from 'csv-parse';

// ================================
// Servicio de Obras
// ================================
class ObrasService {
  /**
   * Carga la tabla de equivalencias desde el archivo CSV
   */
  static async loadFieldMapping(): Promise<Map<number, {campo: string, tipo: string}>> {
    const mappingPath = '/home/osmos/proyectos/svelte-trello/database/tabla equivalencia campos v2.csv';

    try {
      console.log(`📊 [OBRAS] Cargando CSV desde: ${mappingPath}`);
      const csvContent = await fs.readFile(mappingPath, 'utf-8');
      console.log(`📊 [OBRAS] CSV leído, tamaño: ${csvContent.length} chars`);
      console.log(`📊 [OBRAS] Primeros 200 chars: ${csvContent.substring(0, 200)}`);

      // Remover BOM si existe
      const cleanContent = csvContent.replace(/^\uFEFF/, '');
      console.log(`📊 [OBRAS] Contenido limpio (primeros 200 chars): ${cleanContent.substring(0, 200)}`);

      // Usar parseCSV de manera síncrona con el contenido ya leído
      const records = await new Promise((resolve, reject) => {
        parseCSV(cleanContent, {
          columns: true,
          delimiter: ';',
          skip_empty_lines: true
        }, (err, data) => {
          if (err) {
            console.error(`❌ [OBRAS] Error parseando CSV:`, err);
            reject(err);
          } else {
            console.log(`📊 [OBRAS] CSV parseado, ${data.length} registros encontrados`);
            console.log(`📊 [OBRAS] Primer registro:`, data[0]);
            resolve(data);
          }
        });
      }) as any[];

      const mapping = new Map<number, {campo: string, tipo: string}>();

      for (const record of records) {
        console.log(`📊 [OBRAS] Procesando registro:`, record);
        const columnaExcel = parseInt(record['Columna Excel'], 10);
        const campoBD = record['Nombre campo en base datos'];
        const tipoDato = record['Tipo dato'];

        console.log(`📊 [OBRAS] - Columna Excel: "${record['Columna Excel']}" -> ${columnaExcel}`);
        console.log(`📊 [OBRAS] - Campo BD: "${campoBD}"`);
        console.log(`📊 [OBRAS] - Tipo dato: "${tipoDato}"`);

        if (!isNaN(columnaExcel) && campoBD && tipoDato) {
          // El campo ya viene limpio en la nueva tabla de equivalencias
          mapping.set(columnaExcel, {
            campo: campoBD.trim(), // Solo limpiamos espacios
            tipo: tipoDato.trim()
          });
          console.log(`✅ [OBRAS] Mapeado: Columna ${columnaExcel} -> ${campoBD.trim()}`);
        } else {
          console.log(`❌ [OBRAS] Registro inválido - columnaExcel: ${columnaExcel}, campoBD: "${campoBD}", tipoDato: "${tipoDato}"`);
        }
      }

      console.log(`📊 [OBRAS] Tabla de equivalencias cargada: ${mapping.size} campos mapeados`);

      // Debug: mostrar todos los mapeos cargados CON ESPECIAL ATENCION A COLUMNAS 5 y 6
      console.log(`📊 [OBRAS] DEBUG - Mapeos cargados:`);
      for (const [col, field] of mapping.entries()) {
        if (col === 5 || col === 6) {
          console.log(`🔥 COLUMNA ${col} -> ${field.campo} (${field.tipo}) ⭐`);
        } else {
          console.log(`   Columna ${col} -> ${field.campo} (${field.tipo})`);
        }
      }

      return mapping;

    } catch (error) {
      console.error('❌ [OBRAS] Error cargando tabla de equivalencias:', error);
      throw new Error(`Error cargando tabla de equivalencias: ${error.message}`);
    }
  }

  /**
   * Mapea los datos del Excel usando la tabla de equivalencias
   */
  static mapExcelData(excelRow: any, fieldMapping: Map<number, {campo: string, tipo: string}>): any {
    const mappedData: any = {};

    // Obtener las columnas del Excel como array ordenado
    const columns = Object.keys(excelRow);

    console.log(`📊 [OBRAS] DEBUG mapExcelData - Columnas disponibles: ${columns.length}`);
    console.log(`📊 [OBRAS] DEBUG mapExcelData - Mapeos a procesar: ${fieldMapping.size}`);

    for (const [excelColumn, fieldInfo] of fieldMapping.entries()) {
      // Las columnas en Excel empiezan desde 1, pero en el array desde 0
      const columnIndex = excelColumn - 1;
      const columnKey = columns[columnIndex];

      console.log(`📊 [OBRAS] DEBUG - Procesando columna Excel ${excelColumn} (index ${columnIndex})`);
      console.log(`   - columnKey: "${columnKey}"`);
      console.log(`   - fieldInfo.campo: "${fieldInfo.campo}"`);

      if (columnKey !== undefined) {
        let value = excelRow[columnKey];
        // Debug especial para columna 6 (cod_integracion)
        if (excelColumn === 6) {
          console.log(`🔍 [OBRAS] COLUMNA 6 DEBUG - columnKey: "${columnKey}", valor RAW: ${JSON.stringify(value)}, tipo: ${typeof value}`);
        }

        // Aplicar conversiones según el tipo de dato
        switch (fieldInfo.tipo) {
          case 'text':
            mappedData[fieldInfo.campo] = value || null;
            break;
          case 'bool':
            // Campo boolean: convertir estado
            mappedData[fieldInfo.campo] = this.convertEstadoToBool(value);
            break;
          case 'int4':
            mappedData[fieldInfo.campo] = this.excelToInt(value);
            break;
          case 'int8':
            mappedData[fieldInfo.campo] = this.excelToInt(value);
            break;
          case 'numeric(10 2)':
            mappedData[fieldInfo.campo] = this.excelToNumeric(value);
            break;
          case 'date':
            mappedData[fieldInfo.campo] = this.excelDateToPostgres(value);
            break;
          default:
            mappedData[fieldInfo.campo] = value || null;
            break;
        }

        if (mappedData[fieldInfo.campo] !== undefined) {
          // Solo mostrar log para campos importantes
          if (fieldInfo.campo === 'codigo' || fieldInfo.campo === 'cod_integracion') {
            console.log(`📊 [OBRAS] Mapeo: Columna Excel ${excelColumn} (${columnKey}) -> ${fieldInfo.campo} = ${mappedData[fieldInfo.campo]} (tipo: ${fieldInfo.tipo})`);
          }
        }
      }
    }

    // Debug específico para verificar los campos clave
    console.log(`🔍 [OBRAS] MAPEO FINAL - codigo: ${mappedData.codigo || 'VACÍO'}, cod_integracion: ${mappedData.cod_integracion || 'VACÍO'}`);

    // Debug extra para mostrar TODOS los campos mapeados en el primer registro
    if (Object.keys(mappedData).length > 0) {
      const campos = Object.keys(mappedData).slice(0, 6); // Solo primeros 6 campos
      console.log(`📊 [OBRAS] CAMPOS MAPEADOS (muestra): ${campos.map(c => `${c}=${mappedData[c]}`).join(', ')}`);
    }

    return mappedData;
  }

  /**
   * Convierte el estado del proyecto a boolean
   */
  static convertEstadoToBool(estadoValue: any): boolean {
    if (!estadoValue) return true; // Por defecto activo

    const estado = String(estadoValue).toLowerCase().trim();

    // Estados que indican que el proyecto está inactivo/cerrado
    const estadosInactivos = ['cerrado', 'cancelado', 'suspendido', 'terminado', 'finalizado'];

    return !estadosInactivos.includes(estado);
  }
  /**
   * Ejecuta el scraper C# para descargar un nuevo archivo Excel
   */
  static async downloadNewExcelFile(): Promise<{ success: boolean; message: string; fileName?: string }> {
    const { exec } = require('child_process');
    const scraperPath = '/home/osmos/proyectos/svelte-trello/hono-kanban/cvi_downloader';

    try {
      console.log(`📥 [OBRAS] Iniciando descarga de nuevo Excel...`);

      return new Promise((resolve) => {
        exec('./Scrapping', { cwd: scraperPath, timeout: 120000 }, (error, stdout, stderr) => {
          if (error) {
            console.error(`❌ [OBRAS] Error ejecutando scraper:`, error.message);
            resolve({
              success: false,
              message: `Error ejecutando el scraper: ${error.message}`
            });
            return;
          }

          if (stderr) {
            console.warn(`⚠️ [OBRAS] Advertencias del scraper:`, stderr);
          }

          console.log(`✅ [OBRAS] Scraper ejecutado exitosamente`);
          console.log(`📊 [OBRAS] Output:`, stdout);

          // Extraer nombre del archivo del output
          const fileNameMatch = stdout.match(/¡Archivo descargado!: (.+)/);
          const fileName = fileNameMatch ? fileNameMatch[1] : 'archivo_descargado.xlsx';

          resolve({
            success: true,
            message: 'Excel descargado exitosamente',
            fileName
          });
        });
      });
    } catch (error) {
      console.error(`❌ [OBRAS] Error inesperado:`, error);
      return {
        success: false,
        message: `Error inesperado: ${error.message}`
      };
    }
  }
  /**
   * Lee el archivo Excel más reciente de la carpeta de descargas
   */
  static async getLatestExcelFile(): Promise<string | null> {
    const excelDir = '/home/osmos/proyectos/svelte-trello/hono-kanban/cvi_downloader/descargas_excel';
    
    try {
      const files = await fs.readdir(excelDir);
      const excelFiles = files.filter(file => file.endsWith('.xlsx') || file.endsWith('.xls'));
      
      if (excelFiles.length === 0) {
        return null;
      }
      
      // Obtener información de archivos con fechas de modificación
      const filesWithStats = await Promise.all(
        excelFiles.map(async (file) => {
          const filePath = path.join(excelDir, file);
          const stats = await fs.stat(filePath);
          return { file, path: filePath, modified: stats.mtime };
        })
      );
      
      // Ordenar por fecha de modificación (más reciente primero)
      filesWithStats.sort((a, b) => b.modified.getTime() - a.modified.getTime());

      // Limpiar archivos antiguos - mantener solo los 3 más recientes
      if (filesWithStats.length > 3) {
        const filesToDelete = filesWithStats.slice(3); // Archivos del 4° en adelante
        console.log(`🧹 [OBRAS] Limpiando ${filesToDelete.length} archivos Excel antiguos`);

        for (const fileToDelete of filesToDelete) {
          try {
            await fs.unlink(fileToDelete.path);
            console.log(`🗑️ [OBRAS] Archivo eliminado: ${fileToDelete.file}`);
          } catch (deleteError) {
            console.warn(`⚠️ [OBRAS] Error eliminando archivo ${fileToDelete.file}:`, deleteError.message);
          }
        }
      }

      return filesWithStats[0].path;
    } catch (error) {
      console.error('Error leyendo directorio Excel:', error);
      return null;
    }
  }

  /**
   * Procesa el archivo Excel y extrae solo la columna 6 (cod_integracion)
   */
  static async processExcelFile(filePath: string) {
    console.log(`📊 [OBRAS] Procesando archivo Excel: ${filePath}`);

    const workbook = XLSX.readFile(filePath);
    console.log(`📊 [OBRAS] Hojas disponibles:`, workbook.SheetNames);

    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    console.log(`📊 [OBRAS] Procesando hoja: ${sheetName}`);

    // Convertir a JSON desde la fila 7 (donde están los datos)
    const rawData = XLSX.utils.sheet_to_json(worksheet, {
      range: 6, // Fila 7 (índice 6) - datos reales
      header: 1, // Usar la primera fila como headers
      defval: null // Valor por defecto para celdas vacías
    });

    console.log(`📊 [OBRAS] Datos crudos extraídos: ${rawData.length} registros`);
    if (rawData.length > 0) {
      console.log(`📊 [OBRAS] Primer registro crudo:`, JSON.stringify(rawData[0], null, 2));
      console.log(`📊 [OBRAS] Campos en primer registro:`, Object.keys(rawData[0]));

      // Debug específico para las primeras columnas
      const columns = Object.keys(rawData[0]);
      console.log(`📊 [OBRAS] DEBUG - Primeras 10 columnas del Excel:`);
      for (let i = 0; i < Math.min(10, columns.length); i++) {
        console.log(`   Columna ${i + 1}: "${columns[i]}" = ${JSON.stringify(rawData[0][columns[i]])}`);
      }
    }

    // Mapear las primeras 5 columnas: B,C,D,E,F (índices 1,2,3,4) - HARDCODEADO
    const mappedData = rawData.map((row, index) => {
      try {
        const columns = Object.keys(row);

        // Extraer valores de las columnas
        const mercado = row[columns[0]];        // Índice 0
        const ciudad = row[columns[1]];         // Índice 1
        const cadena = row[columns[2]];         // Índice 2
        const codigo = row[columns[3]];         // Índice 3
        const codIntegracion = row[columns[4]]; // Índice 4 - cod_integracion
        const nombreProyecto = row[columns[6]]; // Índice 6 (corregido)
        const activo = true; // Siempre true si está en el Excel (activo)
        const inmueble = row[columns[9]];       // Índice 9
        const supAlq = row[columns[15]];        // Índice 15 (corregido)
        const btSolicitud = row[columns[30]];   // Índice 30 (corregido)
        const inicioObraPrevista = row[columns[43]]; // Índice 43 (corregido)
        const inicioObraReal = row[columns[44]];     // Índice 44 (corregido)
        const apertEspacioPrevista = row[columns[51]]; // Índice 51 (corregido)
        const descripcion = row[columns[53]];   // Índice 53 (corregido)

        // Filtrar filas vacías o sin código de integración válido
        if (!codIntegracion || codIntegracion === "" || codIntegracion === null || codIntegracion === undefined) {
          // Fila vacía, saltar silenciosamente
          return null;
        }

        if (index === 0) {
          console.log(`📊 [OBRAS] Verificando nombre_proyecto en fila 1:`);
          console.log(`   Índice [6]: "${row[columns[6]]}" (nombre_proyecto)`);
          console.log(`   Índice [5]: "${row[columns[5]]}" (referencia)`);
          console.log(`   Índice [7]: "${row[columns[7]]}" (referencia)`);
        }

        return {
          mercado: mercado || null,
          ciudad: ciudad || null,
          cadena: cadena || null,
          codigo: this.excelToInt(codigo),
          cod_integracion: this.excelToInt(codIntegracion),
          nombre_proyecto: nombreProyecto || null,
          activo: activo || null,
          inmueble: inmueble || null,
          sup_alq: supAlq || null,
          bt_solicitud: this.excelToDate(btSolicitud),
          inicio_obra_prevista: this.excelToDate(inicioObraPrevista),
          inicio_obra_real: this.excelToDate(inicioObraReal),
          apert_espacio_prevista: this.excelToDate(apertEspacioPrevista),
          descripcion: descripcion || null
        };
      } catch (error) {
        console.error(`❌ [OBRAS] Error mapeando fila ${index + 1}:`, error);
        return null;
      }
    }).filter(row => row !== null);

    console.log(`📊 [OBRAS] Datos mapeados: ${mappedData.length} registros válidos`);

    return mappedData;
  }

  /**
   * Convierte fecha de Excel a formato PostgreSQL
   */
  static excelDateToPostgres(excelDate: any): string | null {
    if (!excelDate || excelDate === '') return null;

    // Si ya es una fecha
    if (excelDate instanceof Date) {
      // Usar fecha local en lugar de UTC para evitar problemas de zona horaria
      const year = excelDate.getFullYear();
      const month = String(excelDate.getMonth() + 1).padStart(2, '0');
      const day = String(excelDate.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    // Si es un número de Excel (días desde 1900-01-01)
    if (typeof excelDate === 'number') {
      const date = XLSX.SSF.parse_date_code(excelDate);
      if (date) {
        return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
      }
    }

    // Si es string, intentar parsearlo
    if (typeof excelDate === 'string') {
      const parsed = new Date(excelDate);
      if (!isNaN(parsed.getTime())) {
        // Usar fecha local en lugar de UTC
        const year = parsed.getFullYear();
        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const day = String(parsed.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    }

    return null;
  }

  /**
   * Convierte valores de Excel a entero para campos int4
   */
  static excelToInt(value: any): number | null {
    if (value === null || value === undefined || value === '' || value === 'null') return null;
    
    // Si es un número, convertir a entero
    if (typeof value === 'number') {
      return Math.floor(value);
    }
    
    // Si es string, intentar convertir
    if (typeof value === 'string') {
      // Limpiar espacios y caracteres no numéricos básicos
      const cleaned = value.trim();

      // Lista de valores no enteros que deben ser null
      const nonIntegerValues = ['', 'N/A', 'n/a', 'Abierto', 'abierto', 'ABIERTO', 'null', 'NULL', '-', '--'];
      if (nonIntegerValues.includes(cleaned)) return null;

      const num = parseInt(cleaned, 10);
      return isNaN(num) ? null : num;
    }
    
    return null;
  }

  /**
   * Convierte valores de Excel a fecha para campos date
   */
  static excelToDate(value: any): string | null {
    if (value === null || value === undefined || value === '' || value === 'null') return null;

    try {
      // Si es un número (fecha serial de Excel)
      if (typeof value === 'number') {
        // Excel almacena fechas como días desde 1900-01-01 (con ajuste de 1 día)
        const excelEpoch = new Date(1900, 0, 1); // 1 enero 1900
        const date = new Date(excelEpoch.getTime() + (value - 2) * 24 * 60 * 60 * 1000);

        // Verificar que sea una fecha válida
        if (isNaN(date.getTime())) return null;

        // Retornar en formato YYYY-MM-DD para PostgreSQL
        return date.toISOString().split('T')[0];
      }

      // Si es string, intentar parsear diferentes formatos
      if (typeof value === 'string') {
        const cleaned = value.trim();

        // Lista de valores no válidos para fechas
        const invalidValues = ['', 'N/A', 'n/a', 'null', 'NULL', '-', '--', 'TBD', 'tbd'];
        if (invalidValues.includes(cleaned)) return null;

        // Intentar parsear como fecha
        const date = new Date(cleaned);
        if (isNaN(date.getTime())) return null;

        return date.toISOString().split('T')[0];
      }

      // Si es objeto Date
      if (value instanceof Date) {
        if (isNaN(value.getTime())) return null;
        return value.toISOString().split('T')[0];
      }

    } catch (error) {
      console.warn(`⚠️ [OBRAS] Error convirtiendo fecha: ${value}`, error);
    }

    return null;
  }

  /**
   * Convierte valores de Excel a número decimal para campos numeric
   */
  static excelToNumeric(value: any): number | null {
    if (value === null || value === undefined || value === '' || value === 'null') return null;
    
    // Si es un número, devolverlo directamente
    if (typeof value === 'number') {
      return value;
    }
    
    // Si es string, intentar convertir
    if (typeof value === 'string') {
      // Limpiar espacios y caracteres no numéricos básicos
      const cleaned = value.trim().replace(',', '.');

      // Lista de valores no numéricos que deben ser null
      const nonNumericValues = ['', 'N/A', 'n/a', 'Abierto', 'abierto', 'ABIERTO', 'null', 'NULL', '-', '--'];
      if (nonNumericValues.includes(cleaned)) return null;

      const num = parseFloat(cleaned);
      return isNaN(num) ? null : num;
    }
    
    return null;
  }

  /**
   * Trunca texto para campos VARCHAR con límite de longitud
   */
  static truncateString(value: any, maxLength: number): string | null {
    if (value === null || value === undefined || value === '') return null;
    
    const str = String(value).trim();
    if (str === '' || str === 'N/A' || str === 'n/a') return null;
    
    return str.length > maxLength ? str.substring(0, maxLength) : str;
  }

  /**
   * Actualiza un registro en la tabla proyectos
   */
  static async updateProyecto(data: any, userId: number, results: any) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Buscar si el proyecto ya existe por cod_integracion (clave principal)
      const codIntegracion = data.cod_integracion;

      if (!codIntegracion) {
        throw new Error(`cod_integracion inválido o vacío: ${data.cod_integracion}`);
      }

      const existingQuery = 'SELECT * FROM proyectos WHERE cod_integracion = $1 AND (creado_manualmente = false OR creado_manualmente IS NULL)';
      const existing = await client.query(existingQuery, [codIntegracion]);

      console.log(`🔍 [OBRAS] Buscando cod_integracion: ${codIntegracion}`);
      console.log(`📊 [OBRAS] Registros encontrados: ${existing.rows.length}`);

      let isUpdate = false;
      let projectId: number;
      let actionResult: any;
      
      if (existing.rows.length > 0) {
        // Actualizar registro existente
        isUpdate = true;
        projectId = existing.rows[0].id;

        // Comparar campos para detectar cambios - solo campos simplificados
        const oldRecord = existing.rows[0];
        const changes = [];

        // Comparar todos los campos que importamos
        const fieldsToCompare = [
          'mercado', 'ciudad', 'cadena', 'codigo', 'cod_integracion',
          'nombre_proyecto', 'activo', 'inmueble', 'sup_alq', 'bt_solicitud',
          'inicio_obra_prevista', 'inicio_obra_real', 'apert_espacio_prevista', 'descripcion'
        ];

        for (const field of fieldsToCompare) {
          let newValue = data[field];
          let oldValue = oldRecord[field];

          // Aplicar conversiones según el tipo de campo
          if (field === 'codigo') {
            // Campos enteros
            if (typeof oldValue === 'string') {
              oldValue = parseInt(oldValue, 10);
              oldValue = isNaN(oldValue) ? null : oldValue;
            }
          } else if (field === 'sup_alq') {
            // Campo numérico decimal
            if (typeof oldValue === 'string') {
              oldValue = parseFloat(oldValue);
              oldValue = isNaN(oldValue) ? null : oldValue;
            }
          } else if (field === 'bt_solicitud' || field === 'inicio_obra_prevista' ||
                     field === 'inicio_obra_real' || field === 'apert_espacio_prevista') {
            // Campos de fecha - normalizar a string YYYY-MM-DD
            if (oldValue instanceof Date) {
              const year = oldValue.getFullYear();
              const month = String(oldValue.getMonth() + 1).padStart(2, '0');
              const day = String(oldValue.getDate()).padStart(2, '0');
              oldValue = `${year}-${month}-${day}`;
            } else if (typeof oldValue === 'string' && oldValue.includes('T')) {
              oldValue = oldValue.split('T')[0];
            }
          } else {
            // Campos de texto - normalizar valores nulos/vacíos
            if (newValue === null || newValue === undefined || newValue === '') {
              newValue = null;
            } else {
              newValue = String(newValue).trim();
              if (newValue === '') newValue = null;
            }

            if (oldValue === null || oldValue === undefined || oldValue === '') {
              oldValue = null;
            } else {
              oldValue = String(oldValue).trim();
              if (oldValue === '') oldValue = null;
            }
          }

          if (newValue !== oldValue) {
            changes.push({
              campo: field,
              valorAnterior: oldValue,
              valorNuevo: newValue
            });

            console.log(`🔍 [OBRAS] CAMBIO DETECTADO en cod_integracion ${codIntegracion}, campo ${field}:`);
            console.log(`   oldValue: ${JSON.stringify(oldValue)} -> newValue: ${JSON.stringify(newValue)}`);
          }
        }

        if (changes.length > 0) {
          // Realizar actualización con la nueva estructura
          const updateQuery = `
            UPDATE proyectos SET
              mercado = $1, ciudad = $2, cadena = $3, codigo = $4, cod_integracion = $5,
              nombre_proyecto = $6, activo = $7, inmueble = $8, sup_alq = $9,
              bt_solicitud = $10, inicio_obra_prevista = $11, inicio_obra_real = $12,
              apert_espacio_prevista = $13, descripcion = $14, fecha_cambio = CURRENT_TIMESTAMP
            WHERE cod_integracion = $15
          `;

          const values = [
            data.mercado || null,
            data.ciudad || null,
            data.cadena || null,
            data.codigo || null,
            data.cod_integracion,
            data.nombre_proyecto || null,
            data.activo || null,
            data.inmueble || null,
            data.sup_alq || null,
            data.bt_solicitud,
            data.inicio_obra_prevista,
            data.inicio_obra_real,
            data.apert_espacio_prevista,
            data.descripcion || null,
            data.cod_integracion // WHERE clause
          ];

          await client.query(updateQuery, values);

          // Registrar cambios en el historial
          try {
            for (const change of changes) {
              const historialQuery = `
                INSERT INTO proyectos_historial (proyecto_id, usuario_id, tipo_accion, campo_modificado, valor_anterior, valor_nuevo)
                VALUES ($1, $2, $3, $4, $5, $6)
              `;
              await client.query(historialQuery, [
                projectId, userId, 'UPDATE', change.campo, change.valorAnterior, change.valorNuevo
              ]);
            }
            console.log(`📝 [OBRAS] Historial de cambios registrado para proyecto: ${projectId}`);
          } catch (historialError) {
            console.warn(`⚠️ [OBRAS] Error registrando historial de cambios (no crítico): ${historialError.message}`);
          }

          console.log(`📝 [OBRAS] Proyecto actualizado: ${codIntegracion} (${changes.length} cambios)`);
          actionResult = { action: 'updated', projectId, changes: changes.length };
        } else {
          console.log(`📝 [OBRAS] Proyecto sin cambios: ${codIntegracion}`);
          actionResult = { action: 'no_changes', projectId, changes: 0 };
        }
        
      } else {
        // Crear nuevo registro con todos los campos
        const insertQuery = `
          INSERT INTO proyectos (
            mercado, ciudad, cadena, codigo, cod_integracion,
            nombre_proyecto, activo, inmueble, sup_alq, bt_solicitud,
            inicio_obra_prevista, inicio_obra_real, apert_espacio_prevista, descripcion,
            creado_manualmente
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING id
        `;

        const values = [
          data.mercado || null,
          data.ciudad || null,
          data.cadena || null,
          data.codigo || null,
          data.cod_integracion,
          data.nombre_proyecto || null,
          data.activo || null,
          data.inmueble || null,
          data.sup_alq || null,
          data.bt_solicitud,
          data.inicio_obra_prevista,
          data.inicio_obra_real,
          data.apert_espacio_prevista,
          data.descripcion || null,
          false // creado_manualmente - siempre false para registros del Excel
        ];

        console.log(`📊 [OBRAS] DEBUG INSERT - Values: ${values.length} [${values.join(', ')}]`);

        const result = await client.query(insertQuery, values);
        projectId = result.rows[0].id;
        console.log(`💾 [OBRAS] INSERT exitoso - ID generado: ${projectId} para cod_integracion: ${codIntegracion}`);

        // Registrar creación en el historial
        try {
          const historialQuery = `
            INSERT INTO proyectos_historial (proyecto_id, usuario_id, tipo_accion)
            VALUES ($1, $2, $3)
          `;
          await client.query(historialQuery, [projectId, userId, 'CREATE']);
          console.log(`📝 [OBRAS] Historial registrado para proyecto: ${projectId}`);
        } catch (historialError) {
          console.warn(`⚠️ [OBRAS] Error registrando historial (no crítico): ${historialError.message}`);
        }

        console.log(`✨ [OBRAS] Proyecto creado: ${codIntegracion}`);
        actionResult = { action: 'created', projectId, changes: 1 };
      }

      await client.query('COMMIT');
      console.log(`✅ [OBRAS] TRANSACCIÓN CONFIRMADA - Proyecto ${actionResult.action}: ${codIntegracion} (ID: ${projectId})`);
      return actionResult;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Procesa el archivo Excel completo y actualiza la base de datos
   */
  static async processAndUpdateFromExcel(userId: number) {
    const filePath = await this.getLatestExcelFile();
    
    if (!filePath) {
      throw new Error('No se encontró ningún archivo Excel en el directorio');
    }
    
    console.log(`📊 [OBRAS] Iniciando procesamiento de: ${filePath}`);
    const data = await this.processExcelFile(filePath);
    
    const results = {
      processed: 0,
      created: 0,
      updated: 0,
      noChanges: 0,
      errors: 0,
      fileName: path.basename(filePath)
    };
    
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      
      // Progress logging cada 50 registros para no saturar logs
      if (i % 50 === 0 || i < 3) {
        console.log(`📊 [OBRAS] Progreso: ${i + 1}/${data.length} registros procesados`);
      }
      
      // Validar que tenga cod_integracion válido (única columna que importamos)
      if (!row.cod_integracion) {
        console.warn(`⚠️ [OBRAS] Fila ${i + 1} sin cod_integracion válido, saltando. Valor: "${row.cod_integracion}"`);
        results.errors++;
        continue;
      }

      try {
        console.log(`📊 [OBRAS] Procesando cod_integracion: ${row.cod_integracion}`);
        const result = await this.updateProyecto(row, userId, results);
        results.processed++;
        
        if (result.action === 'created') {
          results.created++;
        } else if (result.action === 'updated') {
          results.updated++;
        } else if (result.action === 'no_changes') {
          results.noChanges++;
        }
        
        if (i < 3) {
          console.log(`✅ [OBRAS] Registro ${i + 1} procesado exitosamente:`, result);
        }
        
      } catch (error) {
        console.error(`❌ [OBRAS] Error procesando registro ${i + 1}, codigo ${row.codigo}:`, error);
        console.error(`❌ [OBRAS] Stack trace:`, error.stack);
        results.errors++;
      }
    }

    // Desactivar proyectos que no aparecieron en este Excel
    try {
      console.log(`🔄 [OBRAS] Iniciando desactivación de proyectos no presentes en Excel...`);

      // Obtener lista de cod_integracion que aparecieron en este Excel
      const codIntegracionesEnExcel = mappedData.map(row => row.cod_integracion);
      console.log(`📊 [OBRAS] Proyectos en Excel: ${codIntegracionesEnExcel.length}`);

      const client = await connectDB();

      // Query para desactivar proyectos que no están en el Excel actual
      // Solo desactivamos los que no fueron creados manualmente
      const deactivateQuery = `
        UPDATE proyectos
        SET activo = false, fecha_cambio = CURRENT_TIMESTAMP
        WHERE cod_integracion NOT IN (${codIntegracionesEnExcel.map((_, i) => `$${i + 1}`).join(', ')})
        AND (creado_manualmente = false OR creado_manualmente IS NULL)
        AND activo = true
        RETURNING cod_integracion, mercado, ciudad
      `;

      const deactivateResult = await client.query(deactivateQuery, codIntegracionesEnExcel);
      console.log(`📊 [OBRAS] Proyectos desactivados: ${deactivateResult.rows.length}`);

      if (deactivateResult.rows.length > 0) {
        console.log(`📋 [OBRAS] Proyectos desactivados:`, deactivateResult.rows.slice(0, 5).map(r => `${r.cod_integracion} (${r.mercado})`));
      }

      // Actualizar resultados
      results.deactivated = deactivateResult.rows.length;

      await client.end();

    } catch (error) {
      console.error(`❌ [OBRAS] Error desactivando proyectos no presentes:`, error);
      results.deactivationErrors = 1;
    }

    console.log(`✅ [OBRAS] Procesamiento completo:`, results);
    return results;
  }
}

// ================================
// Rutas de la API
// ================================
export const obrasRoutes = new Hono<{ Variables: Variables }>();

/**
 * POST /api/obras/download-excel
 * Descarga un nuevo archivo Excel ejecutando el scraper
 */
obrasRoutes.post('/api/obras/download-excel', keycloakAuthMiddleware, async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    console.log(`📥 [OBRAS] Iniciando descarga de Excel por usuario: ${user.userId}`);

    const result = await ObrasService.downloadNewExcelFile();

    if (result.success) {
      return c.json({
        success: true,
        message: result.message,
        fileName: result.fileName
      });
    } else {
      return c.json({
        success: false,
        error: result.message
      }, 500);
    }

  } catch (error) {
    console.error('❌ [OBRAS] Error descargando Excel:', error);
    return c.json({
      success: false,
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * POST /api/obras/download-and-process
 * Descarga un nuevo Excel y lo procesa inmediatamente
 */
obrasRoutes.post('/api/obras/download-and-process', keycloakAuthMiddleware, async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    console.log(`🔄 [OBRAS] Iniciando descarga y procesamiento completo por usuario: ${user.userId}`);

    // Paso 1: Descargar nuevo Excel
    console.log(`📥 [OBRAS] Paso 1: Descargando nuevo archivo Excel...`);
    const downloadResult = await ObrasService.downloadNewExcelFile();

    if (!downloadResult.success) {
      return c.json({
        success: false,
        error: `Error en la descarga: ${downloadResult.message}`
      }, 500);
    }

    console.log(`✅ [OBRAS] Excel descargado: ${downloadResult.fileName}`);

    // Paso 2: Procesar el Excel descargado
    console.log(`📊 [OBRAS] Paso 2: Procesando Excel descargado...`);
    const processResult = await ObrasService.processAndUpdateFromExcel(user.userId);

    return c.json({
      success: true,
      message: 'Excel descargado y procesado exitosamente',
      download: {
        fileName: downloadResult.fileName
      },
      process: processResult
    });

  } catch (error) {
    console.error('❌ [OBRAS] Error en descarga y procesamiento:', error);
    return c.json({
      success: false,
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * POST /api/obras/process-excel
 * Procesa el archivo Excel más reciente y actualiza la base de datos
 */
obrasRoutes.post('/api/obras/process-excel', keycloakAuthMiddleware, async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }
    
    console.log(`🏗️ [OBRAS] Iniciando procesamiento Excel por usuario: ${user.userId}`);
    
    const results = await ObrasService.processAndUpdateFromExcel(user.userId);
    
    return c.json({
      success: true,
      message: 'Procesamiento completado exitosamente',
      results
    });
    
  } catch (error) {
    console.error('❌ [OBRAS] Error procesando Excel:', error);
    return c.json({
      success: false,
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});