/**
 * 재고: Notion '[재고현황] 입점 상품 운영'(상품×매장 행, 실재고)과 '입출고 이력'(거래 기록).
 * 입출고를 기록하면 이력 페이지를 만들고 재고현황의 실재고를 함께 조정한다.
 */

function listStores_() {
  return cached_('store', 'all', 1800, function () {
    const schema = notionSchema_('store', true);
    if (!schema) return [];
    return notionQueryAll_(schema.sourceId, {}).map(function (page) {
      const row = notionRow_(page, schema);
      return { pageId: row.pageId, name: row.name || '', code: row.code || '', status: row.status || '', channel: row.channel || '', method: row.method || '' };
    }).sort(function (a, b) { return a.name.localeCompare(b.name, 'ko'); });
  });
}

function inventoryView_(row, maps) {
  const product = (row.product || []).map(function (id) { return maps.products[String(id).replace(/-/g, '')]; }).find(Boolean) || {};
  const store = (row.store || []).map(function (id) { return maps.stores[String(id).replace(/-/g, '')]; }).find(Boolean) || {};
  const brand = (row.brand || []).map(function (id) { return maps.brands[String(id).replace(/-/g, '')]; }).find(Boolean) ||
    (product.brandIds || []).map(function (id) { return maps.brands[String(id).replace(/-/g, '')]; }).find(Boolean) || {};
  return {
    pageId: row.pageId, url: row.url, edited: row.edited, createdAt: row.createdAt, name: row.name || '',
    productPageId: (row.product || [])[0] || '', productName: product.name || '', productId: product.productId || '', barcode: product.barcode || '',
    storePageId: (row.store || [])[0] || '', storeName: store.name || '',
    brandCode: brand.code || '', brandName: brand.name || '',
    stock: row.stock == null ? null : row.stock, sample: row.sample == null ? null : row.sample,
    status: row.status || '', method: row.method || '', consign: row.consign, storePrice: row.storePrice,
    location: row.location || '', note: row.note || '', noteType: row.noteType || [], check: !!row.check, delivered: row.delivered || ''
  };
}

function inventoryMaps_() {
  const products = {}, stores = {}, brands = brandMapByPageId_();
  listProducts_().forEach(function (p) { products[String(p.pageId).replace(/-/g, '')] = p; });
  listStores_().forEach(function (s) { stores[String(s.pageId).replace(/-/g, '')] = s; });
  return { products: products, stores: stores, brands: brands };
}

function listInventory_() {
  let maps = null;
  return syncedList_('inventory', 'inventory', function (row) {
    if (!maps) maps = inventoryMaps_();
    return inventoryView_(row, maps);
  });
}

function inventoryOptions_(schema) {
  const pick = function (key) {
    const d = schema && schema.defs[key];
    return d && d[d.type] && d[d.type].options ? d[d.type].options.map(function (o) { return o.name; }) : [];
  };
  const movement = notionSchema_('movement', true);
  const kinds = movement && movement.defs.kind ? movement.defs.kind.select.options.map(function (o) { return o.name; }) : BO.MOVEMENT_KINDS.slice();
  return { status: pick('status'), method: pick('method'), noteType: pick('noteType'), kinds: kinds };
}

function apiInventory_(payload) {
  const schema = notionSchema_('inventory', true);
  if (!schema) return { connected: false, rows: [], stores: [], options: {} };
  let rows = listInventory_();
  if (payload.code) rows = rows.filter(function (r) { return r.brandCode === payload.code; });
  return { connected: true, rows: rows, stores: listStores_(), options: inventoryOptions_(schema), movementConnected: !!notionSchema_('movement', true) };
}

function apiMovements_(payload) {
  const schema = notionSchema_('movement', true);
  if (!schema) return { movements: [] };
  const filter = payload.productPageId ? fRelation_(schema, 'product', assertNotionId_(payload.productPageId, '상품')) : undefined;
  const body = { sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
  if (filter) body.filter = filter;
  const stores = {};
  listStores_().forEach(function (s) { stores[String(s.pageId).replace(/-/g, '')] = s.name; });
  return {
    movements: notionQueryAll_(schema.sourceId, body, 50).map(function (page) {
      const row = notionRow_(page, schema);
      return { pageId: row.pageId, url: row.url, name: row.name || '', kind: row.kind || '', direction: row.direction || '', qty: row.qty, date: row.date || '', state: row.state || '', note: row.note || '', storeName: (row.store || []).map(function (id) { return stores[String(id).replace(/-/g, '')]; }).filter(Boolean).join(', '), createdAt: row.createdAt };
    })
  };
}

/**
 * 입출고 기록.
 * payload: { requestId, inventoryPageId? | (productPageId, storePageId), kind, direction('+'|'-'), qty, date, note, expectedStock }
 */
function apiMovementRecord_(payload) {
  const inventory = notionSchema_('inventory');
  const movement = notionSchema_('movement');
  const direction = payload.direction === '-' ? '-' : payload.direction === '+' ? '+' : '';
  if (!direction) throw userError_('입고(+) 또는 출고(-)를 선택해 주세요.');
  const qty = parseNumber_(payload.qty, '수량', { required: true, min: 1, integer: true });
  if (qty > 1000000) throw userError_('수량을 확인해 주세요.');
  const kind = text_(payload.kind, 50) || (direction === '+' ? '추가 입고' : '재고 조정');
  const date = assertDate_(payload.date || today_(), '처리일');
  return idempotent_('movement-' + assertId_(payload.requestId, '요청 ID'), function () {
    return withLock_(function () {
      const maps = inventoryMaps_();
      let page = null;
      if (payload.inventoryPageId) {
        page = notionPage_(assertNotionId_(payload.inventoryPageId, '재고 행'));
        const parent = page.parent && (page.parent.data_source_id || page.parent.database_id);
        if (!sameId_(parent, inventory.sourceId)) throw userError_('재고현황 DB의 페이지가 아닙니다.');
      } else {
        assertNotionId_(payload.productPageId, '상품');
        assertNotionId_(payload.storePageId, '매장');
        page = notionQueryAll_(inventory.sourceId, { filter: { and: [fRelation_(inventory, 'product', payload.productPageId), fRelation_(inventory, 'store', payload.storePageId)] } }, 2)[0] || null;
      }
      const row = page ? notionRow_(page, inventory) : null;
      const productPageId = row ? (row.product || [])[0] : payload.productPageId;
      const storePageId = row ? (row.store || [])[0] : payload.storePageId;
      const product = maps.products[String(productPageId || '').replace(/-/g, '')];
      const store = maps.stores[String(storePageId || '').replace(/-/g, '')];
      if (!product) throw userError_('상품을 찾을 수 없습니다.');
      if (!store) throw userError_('입점 매장을 찾을 수 없습니다.');
      const before = row && row.stock != null ? Number(row.stock) : 0;
      if (payload.expectedStock != null && payload.expectedStock !== '' && Number(payload.expectedStock) !== before) {
        throw userError_('그 사이 재고가 바뀌었습니다(현재 ' + before + '개). 새로 고친 뒤 다시 입력해 주세요.', 'CONFLICT');
      }
      const after = before + (direction === '+' ? qty : -qty);
      if (after < 0) throw userError_('출고 수량이 현재 재고(' + before + '개)보다 많습니다.');
      const author = activeEmail_();
      // 1) 재고현황 먼저 반영(확인 가능한 값) → 2) 이력 생성. 이력 생성이 실패하면 재고를 되돌린다.
      let inventoryPageId = row ? row.pageId : '';
      if (row) {
        const updated = notionPatch_(row.pageId, notionProps_(inventory, { stock: after }));
        if (Number(notionValue_(notionPropertyById_(updated, inventory.ids.stock))) !== after) throw userError_('재고 반영을 확인하지 못했습니다.');
      } else {
        if (direction === '-') throw userError_('이 매장에 등록된 재고가 없어 출고할 수 없습니다.');
        const values = { name: store.name + ' · ' + product.name, product: [product.pageId], store: [store.pageId], stock: after };
        if (inventory.ids.brand && product.brandIds.length) values.brand = [product.brandIds[0]];
        if (inventory.ids.delivered) values.delivered = date;
        inventoryPageId = notionCreate_(inventory.sourceId, notionProps_(inventory, values)).id;
      }
      try {
        const values = {
          name: store.name + ' · ' + product.name + ' · ' + kind, product: [product.pageId], store: [store.pageId],
          qty: direction === '+' ? qty : -qty, kind: kind, direction: direction, date: date, state: '완료',
          note: [text_(payload.note, 1000), '기록: ' + author + ' (' + before + '→' + after + ')'].filter(Boolean).join(' / ')
        };
        if (movement.ids.brand && product.brandIds.length) values.brand = [product.brandIds[0]];
        notionCreate_(movement.sourceId, notionProps_(movement, values));
      } catch (error) {
        if (row) { try { notionPatch_(row.pageId, notionProps_(inventory, { stock: before })); } catch (revertError) { logError_('movement revert', revertError); } }
        throw error;
      }
      bumpCache_('inventory');
      logInfo_('inventory.movement', { product: product.productId, store: store.name, direction: direction, qty: qty, by: author });
      return { inventoryPageId: inventoryPageId, before: before, after: after };
    });
  });
}

/** 재고 행의 운영 정보(샘플 수량·입점 상태·진열 위치·특이사항·확인 필요) 수정. 실재고는 입출고로만 바꾼다. */
function apiInventoryUpdate_(payload) {
  const schema = notionSchema_('inventory');
  const allowed = ['sample', 'status', 'method', 'location', 'note', 'noteType', 'check', 'consign', 'storePrice'];
  const changes = payload.changes || {};
  const values = {};
  Object.keys(changes).forEach(function (key) {
    if (allowed.indexOf(key) < 0) throw userError_('수정할 수 없는 재고 항목이 있습니다.');
    if (schema.ids[key]) values[key] = changes[key];
  });
  if (!Object.keys(values).length) return { changed: false };
  const page = notionPage_(assertNotionId_(payload.pageId, '재고 행'));
  const parent = page.parent && (page.parent.data_source_id || page.parent.database_id);
  if (!sameId_(parent, schema.sourceId)) throw userError_('재고현황 DB의 페이지가 아닙니다.');
  if (payload.lastEditedAt && page.last_edited_time !== payload.lastEditedAt) throw userError_('다른 사람이 먼저 수정했습니다. 새로 고친 뒤 다시 저장해 주세요.', 'CONFLICT');
  const updated = notionPatch_(page.id, notionProps_(schema, values));
  bumpCache_('inventory');
  return { changed: true, lastEditedAt: updated.last_edited_time };
}
