var BEAUTYORA_ADMIN_WEBAPP_URL_='https://script.google.com/macros/s/AKfycbw8T4GgcG5b9LWQb7OURhZ2lhm1BDdXhvrimbHbsWEx06d9CNS3puUb-K8tXDqsXIMsww/exec';
var BEAUTYORA_PARTNER_WEBAPP_URL_='https://script.google.com/macros/s/AKfycbxpdxVUXPiuZi1ioVbyOcJobzCqFeNZpKnYAL-ayp7X18KVzOIAjqwokSZrR3bx7qmlBg/exec';
var BEAUTYORA_PRODUCT_SHEET_ID_='1Yt5pz29qVULhHhAySEGrdzUY-QzXGzqhGyaA6Y_FiCA';

function beautyoraPartnerMenuOnOpen(){
  SpreadsheetApp.getUi().createMenu('파트너센터')
    .addItem('직원 운영센터 열기','openBeautyoraOperationsCenter')
    .addItem('브랜드 상품등록 페이지 미리보기','openBeautyoraPartnerPreview')
    .addToUi();
}
function openBeautyoraOperationsCenter(){
  showBeautyoraLinkDialog_('직원 운영센터',BEAUTYORA_ADMIN_WEBAPP_URL_+'?view=admin','등록된 Google 계정으로 로그인합니다.');
}
function openBeautyoraPartnerPreview(){
  showBeautyoraLinkDialog_('브랜드 상품등록 페이지',BEAUTYORA_PARTNER_WEBAPP_URL_,'브랜드사가 입력하는 화면을 미리 확인합니다.');
}
function showBeautyoraLinkDialog_(title,url,description){
  var safeTitle=String(title).replace(/[<>&]/g,''),safeDesc=String(description).replace(/[<>&]/g,'');
  var html=HtmlService.createHtmlOutput('<div style="font-family:Pretendard,Arial;padding:24px;color:#292524"><h2 style="margin:0 0 8px">'+safeTitle+'</h2><p style="color:#78716c;margin:0 0 22px">'+safeDesc+'</p><a href="'+url+'" target="_blank" style="display:block;text-align:center;background:#7f1d1d;color:white;text-decoration:none;padding:13px;border-radius:10px;font-weight:700">새 창에서 열기</a></div>').setWidth(420).setHeight(210);
  SpreadsheetApp.getUi().showModalDialog(html,safeTitle);
}
function installBeautyoraPartnerMenu(){
  var exists=ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()==='beautyoraPartnerMenuOnOpen'&&t.getEventType()===ScriptApp.EventType.ON_OPEN});
  if(!exists)ScriptApp.newTrigger('beautyoraPartnerMenuOnOpen').forSpreadsheet(BEAUTYORA_PRODUCT_SHEET_ID_).onOpen().create();
  try{beautyoraPartnerMenuOnOpen()}catch(e){}
  return '파트너센터 메뉴 설치 완료';
}
