// Versión temporal que ignora campos de fecha si no existen en la BD
// Reemplaza el updateCard method solo para testing

static async updateCard(id: string, data: UpdateCardPayload): Promise<Card | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Separar campos de fechas y otros campos
    const { labels, start_date, due_date, ...safeCardFields } = data;
    
    // Solo usar campos que sabemos que existen
    const fieldsToUpdate = Object.keys(safeCardFields) as Array<keyof Omit<UpdateCardPayload, 'labels' | 'start_date' | 'due_date'>>;
    
    let updatedCard: Card | null = null;

    // Actualizar campos seguros primero
    if (fieldsToUpdate.length > 0) {
      const setClause = fieldsToUpdate.map((key, index) => `"${key}" = $${index + 1}`).join(', ');
      const queryValues = fieldsToUpdate.map(key => safeCardFields[key]);
      queryValues.push(id);

      const query = `
        UPDATE cards 
        SET ${setClause}, updated_at = NOW()
        WHERE id = $${queryValues.length} 
        RETURNING *;
      `;
      
      console.log('🔍 [CardService.updateCard] Safe Query:', query);
      console.log('🔍 [CardService.updateCard] Values:', queryValues);
      
      const result = await client.query(query, queryValues);
      if (result.rowCount === 0) {
        throw new Error('Tarjeta no encontrada');
      }
      updatedCard = result.rows[0] as Card;
    } else {
      const result = await client.query('SELECT * FROM cards WHERE id = $1', [id]);
      if (result.rowCount === 0) {
        throw new Error('Tarjeta no encontrada');
      }
      updatedCard = result.rows[0] as Card;
    }

    // TODO: Intentar actualizar fechas cuando las columnas existan
    if (start_date !== undefined || due_date !== undefined) {
      console.log('⚠️ [CardService.updateCard] Fechas ignoradas - columnas no existen aún');
    }

    // Gestionar etiquetas (código existente)
    if (labels !== undefined) {
      // ... resto del código de etiquetas
    }

    await client.query('COMMIT');
    return updatedCard;

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error en CardService.updateCard:", error);
    throw error;
  } finally {
    client.release();
  }
}