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

// ================================
// Servicio de Obras
// ================================
class ObrasService {
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
      
      return filesWithStats[0].path;
    } catch (error) {
      console.error('Error leyendo directorio Excel:', error);
      return null;
    }
  }

  /**
   * Procesa el archivo Excel y extrae los datos
   */
  static async processExcelFile(filePath: string) {
    console.log(`📊 [OBRAS] Procesando archivo Excel: ${filePath}`);
    
    const workbook = XLSX.readFile(filePath);
    console.log(`📊 [OBRAS] Hojas disponibles:`, workbook.SheetNames);
    
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    console.log(`📊 [OBRAS] Procesando hoja: ${sheetName}`);
    
    // Primero ver el rango de la hoja
    const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1:A1');
    console.log(`📊 [OBRAS] Rango de la hoja: ${worksheet['!ref']}, filas: ${range.e.r + 1}, columnas: ${range.e.c + 1}`);
    
    // Leer algunas celdas de las primeras filas para ver la estructura
    console.log(`📊 [OBRAS] Muestra de datos de las primeras filas:`);
    for (let row = 0; row <= Math.min(10, range.e.r); row++) {
      const rowData = [];
      for (let col = 0; col <= Math.min(10, range.e.c); col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = worksheet[cellAddress];
        rowData.push(cell ? cell.v : '');
      }
      console.log(`📊 [OBRAS] Fila ${row + 1}:`, rowData.slice(0, 5)); // Solo las primeras 5 columnas
    }
    
    // Convertir a JSON desde la fila 7 (saltando la fila 6 que son headers)
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { 
      range: 6, // Fila 7 (índice 6) - saltar headers que están en la fila 6
      header: [
        'mercado', 'ciudad', 'cadena', 'codigo', 'cod_integracion', 'cod_cont_proy',
        'proyecto', 'estado_proy', 'inmueble', 'direccion', 'num_local', 'plantas',
        'tipo', 'estado', 'sup_alq', 'secciones', 'franquicia', 'tipo_proy', 'imagen',
        'zonificacion_solicitud', 'zonificacion_entrega', 'plano_lic_solicitud',
        'plano_lic_entrega', 'plano_obra_solicitud', 'plano_obra_entrega',
        'aa_solicitud', 'aa_entrega', 'ci_solicitud', 'ci_entrega', 'bt_solicitud',
        'bt_entrega', 'insp_tecnica_solicitud', 'insp_tecnica_entrega',
        'lic_obra_solicitud', 'lic_obra_entrega', 'aprob_lic', 'aprob_propietario',
        'aprob_cc', 'constructora', 'apertura_cc', 'entrega_local_prevista',
        'entrega_local_real', 'inicio_obra_prevista', 'inicio_obra_real',
        'aprob_mobiliario_prevista', 'aprob_mobiliario_real', 'ent_mobiliario_prevista',
        'ent_mobiliario_real', 'ent_mercancia_prevista', 'ent_mercancia_real',
        'apert_espacio_prevista', 'apert_espacio_real', 'desc_proy', 'obs_generales'
      ]
    });
    
    console.log(`📊 [OBRAS] Datos extraídos: ${jsonData.length} registros`);
    if (jsonData.length > 0) {
      console.log(`📊 [OBRAS] Primer registro:`, JSON.stringify(jsonData[0], null, 2));
      console.log(`📊 [OBRAS] Campos en primer registro:`, Object.keys(jsonData[0]));
    }
    
    return jsonData;
  }

  /**
   * Convierte fecha de Excel a formato PostgreSQL
   */
  static excelDateToPostgres(excelDate: any): string | null {
    if (!excelDate || excelDate === '') return null;
    
    // Si ya es una fecha
    if (excelDate instanceof Date) {
      return excelDate.toISOString().split('T')[0];
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
        return parsed.toISOString().split('T')[0];
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
      if (cleaned === '' || cleaned === 'N/A' || cleaned === 'n/a') return null;
      
      const num = parseInt(cleaned, 10);
      return isNaN(num) ? null : num;
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
      if (cleaned === '' || cleaned === 'N/A' || cleaned === 'n/a' || cleaned === 'Abierto' || cleaned === 'abierto') return null;
      
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
   * Actualiza un registro en la tabla proyectos_inmobiliarios
   */
  static async updateProyecto(data: any, userId: number) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Buscar si el proyecto ya existe por cod_integracion
      const existingQuery = 'SELECT * FROM proyectos_inmobiliarios WHERE cod_integracion = $1';
      const existing = await client.query(existingQuery, [data.cod_integracion]);

      let isUpdate = false;
      let projectId: number;
      let actionResult: any;
      
      if (existing.rows.length > 0) {
        // Actualizar registro existente
        isUpdate = true;
        projectId = existing.rows[0].id;
        
        // Comparar campos para detectar cambios
        const oldRecord = existing.rows[0];
        const changes = [];
        
        // Lista de campos a comparar (excluyendo id, fecha_cambio, activo)
        const fieldsToCompare = [
          'mercado', 'ciudad', 'cadena', 'codigo', 'cod_cont_proy', 'proyecto',
          'estado_proy', 'inmueble', 'direccion', 'num_local', 'plantas', 'tipo',
          'estado', 'sup_alq', 'secciones', 'franquicia', 'tipo_proy', 'imagen',
          'zonificacion_solicitud', 'zonificacion_entrega', 'plano_lic_solicitud',
          'plano_lic_entrega', 'plano_obra_solicitud', 'plano_obra_entrega',
          'aa_solicitud', 'aa_entrega', 'ci_solicitud', 'ci_entrega', 'bt_solicitud',
          'bt_entrega', 'insp_tecnica_solicitud', 'insp_tecnica_entrega',
          'lic_obra_solicitud', 'lic_obra_entrega', 'aprob_lic', 'aprob_propietario',
          'aprob_cc', 'constructora', 'apertura_cc', 'entrega_local_prevista',
          'entrega_local_real', 'inicio_obra_prevista', 'inicio_obra_real',
          'aprob_mobiliario_prevista', 'aprob_mobiliario_real', 'ent_mobiliario_prevista',
          'ent_mobiliario_real', 'ent_mercancia_prevista', 'ent_mercancia_real',
          'apert_espacio_prevista', 'apert_espacio_real', 'desc_proy', 'obs_generales'
        ];
        
        for (const field of fieldsToCompare) {
          let newValue = data[field];
          let oldValue = oldRecord[field];
          
          // Convertir fechas si es necesario
          if (field.includes('_solicitud') || field.includes('_entrega') || field.includes('_prevista') || field.includes('_real') || field === 'apertura_cc') {
            newValue = this.excelDateToPostgres(newValue);
            oldValue = oldValue ? oldValue.toISOString().split('T')[0] : null;
          }
          
          // Normalizar valores nulos
          newValue = newValue === '' || newValue === undefined ? null : newValue;
          oldValue = oldValue === '' || oldValue === undefined ? null : oldValue;
          
          if (newValue !== oldValue) {
            changes.push({
              campo: field,
              valorAnterior: oldValue,
              valorNuevo: newValue
            });
          }
        }
        
        if (changes.length > 0) {
          // Realizar actualización
          const updateQuery = `
            UPDATE proyectos_inmobiliarios SET
              mercado = $1, ciudad = $2, cadena = $3, codigo = $4, cod_cont_proy = $5,
              proyecto = $6, estado_proy = $7, inmueble = $8, direccion = $9, num_local = $10,
              plantas = $11, tipo = $12, estado = $13, sup_alq = $14, secciones = $15,
              franquicia = $16, tipo_proy = $17, imagen = $18, zonificacion_solicitud = $19,
              zonificacion_entrega = $20, plano_lic_solicitud = $21, plano_lic_entrega = $22,
              plano_obra_solicitud = $23, plano_obra_entrega = $24, aa_solicitud = $25,
              aa_entrega = $26, ci_solicitud = $27, ci_entrega = $28, bt_solicitud = $29,
              bt_entrega = $30, insp_tecnica_solicitud = $31, insp_tecnica_entrega = $32,
              lic_obra_solicitud = $33, lic_obra_entrega = $34, aprob_lic = $35,
              aprob_propietario = $36, aprob_cc = $37, constructora = $38, apertura_cc = $39,
              entrega_local_prevista = $40, entrega_local_real = $41, inicio_obra_prevista = $42,
              inicio_obra_real = $43, aprob_mobiliario_prevista = $44, aprob_mobiliario_real = $45,
              ent_mobiliario_prevista = $46, ent_mobiliario_real = $47, ent_mercancia_prevista = $48,
              ent_mercancia_real = $49, apert_espacio_prevista = $50, apert_espacio_real = $51,
              desc_proy = $52, obs_generales = $53, fecha_cambio = CURRENT_TIMESTAMP
            WHERE cod_integracion = $54
          `;
          
          const values = [
            data.mercado || null, data.ciudad || null, data.cadena || null, data.codigo || null, data.cod_cont_proy || null,
            data.proyecto || null, data.estado_proy || null, data.inmueble || null, data.direccion || null, data.num_local || null,
            data.plantas || null, data.tipo || null, data.estado || null, data.sup_alq || null, data.secciones || null,
            data.franquicia || null, data.tipo_proy || null, data.imagen || null, data.zonificacion_solicitud || null,
            data.zonificacion_entrega || null, this.excelDateToPostgres(data.plano_lic_solicitud), this.excelDateToPostgres(data.plano_lic_entrega),
            this.excelDateToPostgres(data.plano_obra_solicitud), this.excelDateToPostgres(data.plano_obra_entrega), this.excelDateToPostgres(data.aa_solicitud),
            this.excelDateToPostgres(data.aa_entrega), this.excelDateToPostgres(data.ci_solicitud), this.excelDateToPostgres(data.ci_entrega), this.excelDateToPostgres(data.bt_solicitud),
            this.excelDateToPostgres(data.bt_entrega), this.excelDateToPostgres(data.insp_tecnica_solicitud), this.excelDateToPostgres(data.insp_tecnica_entrega),
            this.excelDateToPostgres(data.lic_obra_solicitud), this.excelDateToPostgres(data.lic_obra_entrega), data.aprob_lic || null,
            data.aprob_propietario || null, data.aprob_cc || null, data.constructora || null, this.excelDateToPostgres(data.apertura_cc),
            this.excelDateToPostgres(data.entrega_local_prevista), this.excelDateToPostgres(data.entrega_local_real), this.excelDateToPostgres(data.inicio_obra_prevista),
            this.excelDateToPostgres(data.inicio_obra_real), this.excelDateToPostgres(data.aprob_mobiliario_prevista), this.excelDateToPostgres(data.aprob_mobiliario_real),
            this.excelDateToPostgres(data.ent_mobiliario_prevista), this.excelDateToPostgres(data.ent_mobiliario_real), this.excelDateToPostgres(data.ent_mercancia_prevista),
            this.excelDateToPostgres(data.ent_mercancia_real), this.excelDateToPostgres(data.apert_espacio_prevista), this.excelDateToPostgres(data.apert_espacio_real),
            data.desc_proy || null, data.obs_generales || null, data.cod_integracion
          ];
          
          await client.query(updateQuery, values);
          
          // Registrar cambios en el historial (opcional - no debe fallar la transacción principal)
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
            // No relanzar el error - el UPDATE principal debe completarse
          }

          console.log(`📝 [OBRAS] Proyecto actualizado: ${data.cod_integracion} (${changes.length} cambios)`);
          actionResult = { action: 'updated', projectId, changes: changes.length };
        } else {
          console.log(`📝 [OBRAS] Proyecto sin cambios: ${data.cod_integracion}`);
          actionResult = { action: 'no_changes', projectId, changes: 0 };
        }
        
      } else {
        // Crear nuevo registro  
        // Contar columnas manualmente para debug:
        const columns = [
          'mercado', 'ciudad', 'cadena', 'codigo', 'cod_integracion', 'cod_cont_proy', 'proyecto', // 7
          'estado_proy', 'inmueble', 'direccion', 'num_local', 'plantas', 'tipo', 'estado', 'sup_alq', // 8 (total 15)
          'secciones', 'franquicia', 'tipo_proy', 'imagen', 'zonificacion_solicitud', 'zonificacion_entrega', // 6 (total 21)
          'plano_lic_solicitud', 'plano_lic_entrega', 'plano_obra_solicitud', 'plano_obra_entrega', // 4 (total 25)
          'aa_solicitud', 'aa_entrega', 'ci_solicitud', 'ci_entrega', 'bt_solicitud', 'bt_entrega', // 6 (total 31)
          'insp_tecnica_solicitud', 'insp_tecnica_entrega', 'lic_obra_solicitud', 'lic_obra_entrega', // 4 (total 35)
          'aprob_lic', 'aprob_propietario', 'aprob_cc', 'constructora', 'apertura_cc', // 5 (total 40)
          'entrega_local_prevista', 'entrega_local_real', 'inicio_obra_prevista', 'inicio_obra_real', // 4 (total 44)
          'aprob_mobiliario_prevista', 'aprob_mobiliario_real', 'ent_mobiliario_prevista', // 3 (total 47)
          'ent_mobiliario_real', 'ent_mercancia_prevista', 'ent_mercancia_real', // 3 (total 50)
          'apert_espacio_prevista', 'apert_espacio_real', 'desc_proy', 'obs_generales' // 4 (total 54)
        ];
        
        console.log(`📊 [OBRAS] DEBUG - Columnas definidas: ${columns.length}`);
        
        const insertQuery = `
          INSERT INTO proyectos_inmobiliarios (${columns.join(', ')}) 
          VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
          RETURNING id
        `;
        
        // Mapear valores exactamente en el mismo orden que las columnas
        const values = [
          // Grupo 1: datos básicos (7 valores)
          data.mercado || null, 
          data.ciudad || null, 
          data.cadena || null, 
          this.excelToInt(data.codigo), 
          this.excelToInt(data.cod_integracion),
          this.excelToInt(data.cod_cont_proy), 
          data.proyecto || null,
          
          // Grupo 2: estado y ubicación (8 valores)
          this.truncateString(data.estado_proy, 50), 
          data.inmueble || null, 
          data.direccion || null, 
          this.truncateString(data.num_local, 50), 
          this.excelToInt(data.plantas), 
          this.truncateString(data.tipo, 100), 
          this.truncateString(data.estado, 100), 
          this.excelToNumeric(data.sup_alq),
          
          // Grupo 3: secciones y zonificación (6 valores)
          data.secciones || null, 
          this.truncateString(data.franquicia, 50), 
          this.truncateString(data.tipo_proy, 100), 
          data.imagen || null, 
          data.zonificacion_solicitud || null,
          data.zonificacion_entrega || null, 
          
          // Grupo 4: planos (4 valores)
          this.excelDateToPostgres(data.plano_lic_solicitud), 
          this.excelDateToPostgres(data.plano_lic_entrega),
          this.excelDateToPostgres(data.plano_obra_solicitud), 
          this.excelDateToPostgres(data.plano_obra_entrega), 
          
          // Grupo 5: AA, CI, BT (6 valores)
          this.excelDateToPostgres(data.aa_solicitud),
          this.excelDateToPostgres(data.aa_entrega), 
          this.excelDateToPostgres(data.ci_solicitud), 
          this.excelDateToPostgres(data.ci_entrega),
          this.excelDateToPostgres(data.bt_solicitud), 
          this.excelDateToPostgres(data.bt_entrega), 
          
          // Grupo 6: inspecciones y licencias (4 valores)
          this.excelDateToPostgres(data.insp_tecnica_solicitud),
          this.excelDateToPostgres(data.insp_tecnica_entrega), 
          this.excelDateToPostgres(data.lic_obra_solicitud), 
          this.excelDateToPostgres(data.lic_obra_entrega),
          
          // Grupo 7: aprobaciones y constructora (5 valores)
          this.truncateString(data.aprob_lic, 50), 
          this.truncateString(data.aprob_propietario, 50), 
          this.truncateString(data.aprob_cc, 50), 
          data.constructora || null,
          this.excelDateToPostgres(data.apertura_cc), 
          
          // Grupo 8: entregas e inicios (4 valores)
          this.excelDateToPostgres(data.entrega_local_prevista), 
          this.excelDateToPostgres(data.entrega_local_real),
          this.excelDateToPostgres(data.inicio_obra_prevista), 
          this.excelDateToPostgres(data.inicio_obra_real), 
          
          // Grupo 9: mobiliario (3 valores)
          this.excelDateToPostgres(data.aprob_mobiliario_prevista),
          this.excelDateToPostgres(data.aprob_mobiliario_real),
          this.excelDateToPostgres(data.ent_mobiliario_prevista),

          // Grupo 10: mercancía y espacio (3 valores)
          this.excelDateToPostgres(data.ent_mobiliario_real),
          this.excelDateToPostgres(data.ent_mercancia_prevista),
          this.excelDateToPostgres(data.ent_mercancia_real),
          
          // Grupo 11: final (4 valores)
          this.excelDateToPostgres(data.apert_espacio_prevista),
          this.excelDateToPostgres(data.apert_espacio_real), 
          data.desc_proy || null, 
          data.obs_generales || null
        ];
        
        console.log(`📊 [OBRAS] DEBUG INSERT - Columnas definidas: ${columns.length}`);
        console.log(`📊 [OBRAS] DEBUG INSERT - Values proporcionados: ${values.length}`);
        
        // Debug: log any varchar(50) fields that might be too long
        const varchar50Fields = [
          { name: 'estado_proy', value: values[7], index: 7 },
          { name: 'num_local', value: values[11], index: 11 },
          { name: 'franquicia', value: values[19], index: 19 },
          { name: 'aprob_lic', value: values[27], index: 27 },
          { name: 'aprob_propietario', value: values[28], index: 28 },
          { name: 'aprob_cc', value: values[29], index: 29 }
        ];
        
        varchar50Fields.forEach(field => {
          if (field.value && String(field.value).length > 50) {
            console.log(`🚨 [OBRAS] VARCHAR(50) TOO LONG - ${field.name}[${field.index}]: "${String(field.value).substring(0, 60)}..." (length: ${String(field.value).length})`);
          }
        });
        
        const result = await client.query(insertQuery, values);
        projectId = result.rows[0].id;
        console.log(`💾 [OBRAS] INSERT exitoso - ID generado: ${projectId} para cod_integracion: ${data.cod_integracion}`);
        
        // Registrar creación en el historial (opcional - no debe fallar la transacción principal)
        try {
          const historialQuery = `
            INSERT INTO proyectos_historial (proyecto_id, usuario_id, tipo_accion)
            VALUES ($1, $2, $3)
          `;
          await client.query(historialQuery, [projectId, userId, 'CREATE']);
          console.log(`📝 [OBRAS] Historial registrado para proyecto: ${projectId}`);
        } catch (historialError) {
          console.warn(`⚠️ [OBRAS] Error registrando historial (no crítico): ${historialError.message}`);
          // No relanzar el error - el INSERT principal debe completarse
        }

        console.log(`✨ [OBRAS] Proyecto creado: ${data.cod_integracion}`);
        actionResult = { action: 'created', projectId, changes: 1 };
      }

      await client.query('COMMIT');
      console.log(`✅ [OBRAS] TRANSACCIÓN CONFIRMADA - Proyecto ${actionResult.action}: ${data.cod_integracion} (ID: ${projectId})`);
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
      
      // Debug del registro actual
      if (i < 3) { // Solo para los primeros 3 registros para no saturar los logs
        console.log(`📊 [OBRAS] Procesando registro ${i + 1}:`, JSON.stringify(row, null, 2));
      }
      
      // Validar que tenga cod_integracion
      if (!row.cod_integracion) {
        console.warn(`⚠️ [OBRAS] Fila ${i + 1} sin cod_integracion, saltando:`, row);
        results.errors++;
        continue;
      }
      
      try {
        console.log(`📊 [OBRAS] Procesando cod_integracion: ${row.cod_integracion}`);
        const result = await this.updateProyecto(row, userId);
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
        console.error(`❌ [OBRAS] Error procesando registro ${i + 1}, cod_integracion ${row.cod_integracion}:`, error);
        console.error(`❌ [OBRAS] Stack trace:`, error.stack);
        results.errors++;
      }
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