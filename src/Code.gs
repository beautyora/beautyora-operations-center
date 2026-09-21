var SHEET_NAME = '업체 전달용 상품 리스트';const PS={src:'브랜드 전체목록(Notion 자동연동·수정금지)',mg:'상품 제출 관리',tpl:'1ZMcO5kBe2NahrR_XYOW8MlhnhC2GyH_vhIMdUIE36v0',root:'1UFLlB0plUMuphVhgvF6kUMLhCV3nDNVN'};
function onOpenProductSubmission(){return;PartnerCenterMenuSpreadsheetApp.getUi().createMenu('상품 제출 시트').addItem('선택 회사 시트 열기 또는 생성','prepareProductSubmissionSheet').addItem('작성 상태 새로고침','refreshProductSubmissionStatus').addToUi()}
function setupBeautyoraProductSubmission(){var ss=SpreadsheetApp.getActive();mg_(ss);if(!ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()=='onOpenProductSubmission'}))ScriptApp.newTrigger('onOpenProductSubmission').forSpreadsheet(ss).onOpen().create();SpreadsheetApp.getUi().alert('설치 완료: 시트를 새로고침하세요.')}
function prepareProductSubmissionSheet(){var ui=SpreadsheetApp.getUi(),ss=SpreadsheetApp.getActive(),sh=ss.getSheetByName(PS.src);if(!sh||ss.getActiveSheet().getName()!=PS.src){ui.alert('브랜드 전체 목록에서 브랜드 행 하나를 선택해주세요.');return}var n=sh.getActiveRange().getRow(),v=sh.getDataRange().getDisplayValues(),h={};v[0].forEach(function(x,i){h[x.trim()]=i});if(n<2)return;var q=v[n-1],co=(q[h['협력사/회사명']]||q[h['브랜드명']]).trim(),rs=v.slice(1).filter(function(r){return norm_(r[h['협력사/회사명']]||r[h['브랜드명']])==norm_(co)}),bs=uniq_(rs.map(function(r){return r[h['브랜드명']]})),ids=uniq_(rs.map(function(r){return r[h['브랜드 ID']]})),ems=uniq_(rs.map(function(r){return r[h['이메일']]})),dus=uniq_(rs.map(function(r){return r[h['구글 드라이브']]})),mg=mg_(ss),old=find_(mg,co,ids);if(old){links_('기존 제출본',old[0],old[1]);return}if(ui.alert('생성 전 확인','회사: '+co+'\n포함 브랜드: '+bs.join(', ')+'\n\n시트와 이미지 폴더만 만들고 메일은 발송하지 않습니다.',ui.ButtonSet.OK_CANCEL)!=ui.Button.OK)return;var lock=LockService.getDocumentLock();lock.waitLock(20000);try{old=find_(mg,co,ids);if(old){links_('기존 제출본',old[0],old[1]);return}var cf=folder_(dus,ids,co),sp=sub_(cf,'01_상품 제출'),ip=sub_(cf,'02_상품 이미지'),sid='SUB-'+Utilities.formatDate(new Date(),'Asia/Seoul','yyyyMMdd-HHmmss'),im=ip.createFolder(sid+'_'+safe_(co)),f=DriveApp.getFileById(PS.tpl).makeCopy(sid+'_'+safe_(co)+'_상품 제출',sp),ps=SpreadsheetApp.openById(f.getId());init_(ps,sid,co,bs,ids,ems,cf,im);var su=ps.getUrl(),iu=im.getUrl();mg.appendRow([sid,co,bs.join(', '),ems.join(', '),su,iu,new Date(),'작성 전',new Date(),'미검수','미반영',cf.getId(),ids.join(', '),'']);var lr=mg.getLastRow();mg.getRange(lr,5).setFormula('=HYPERLINK("'+su+'","제출 시트 열기")');mg.getRange(lr,6).setFormula('=HYPERLINK("'+iu+'","이미지 폴더 열기")');links_('생성 완료',su,iu)}finally{lock.releaseLock()}}
function refreshProductSubmissionStatus(){var sh=mg_(SpreadsheetApp.getActive()),lr=sh.getLastRow();if(lr<2)return;var rg=sh.getRange(2,1,lr-1,14),fm=rg.getFormulas();rg.getValues().forEach(function(r,i){var st='접근 오류';try{var d=SpreadsheetApp.openById(id_(fm[i][4]||r[4])).getSheetByName('리스트').getRange('B6:O105').getDisplayValues(),e=d.filter(function(x){return x[1]||x[2]});st=!e.length?'작성 전':e.some(function(x){return !x[0]||!x[1]||!x[3]||!x[10]||!x[11]})?'작성 중':'검수 가능'}catch(x){st='오류:'+x.message}sh.getRange(i+2,8,1,2).setValues([[st,new Date()]])});SpreadsheetApp.getUi().alert('작성 상태 새로고침 완료')}
function init_(ss,sid,co,bs,ids,ems,cf,im){ss.setSpreadsheetLocale('ko_KR');ss.setSpreadsheetTimeZone('Asia/Seoul');var l=ss.getSheetByName('리스트');l.getRange('B2:C4').setValues([['회사명',co],['담당자 이메일',ems.join(', ')],['이미지 폴더',im.getUrl()]]);var b=ss.getSheetByName('_BRAND_LIST');b.clearContents();b.getRange(1,1,1,2).setValues([['브랜드 ID','브랜드명']]);var p=bs.map(function(x,i){return[ids[i]||'',x]});if(p.length)b.getRange(2,1,p.length,2).setValues(p);l.getRange('B6:B105').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(b.getRange(2,2,Math.max(1,p.length),1),true).setAllowInvalid(false).build());if(p.length==1)l.getRange('B6:B105').setValue(p[0][1]);ss.getSheetByName('_SYSTEM').getRange(1,1,8,2).setValues([['schema_version','1.0'],['submission_id',sid],['company_name',co],['brand_ids',ids.join(',')],['brand_names',bs.join(',')],['company_folder_id',cf.getId()],['image_folder_id',im.getId()],['created_at',new Date()]])}
function mg_(s){return s.getSheetByName(PS.mg)} function find_(s,c,ids){if(s.getLastRow()<2)return null;var a=s.getRange(2,1,s.getLastRow()-1,14).getValues(),z=ids.map(norm_);for(var i=a.length-1;i>=0;i--){var r=a[i],e=String(r[12]).split(',').map(norm_);if(String(r[10])!='등록 완료'&&(norm_(r[1])==norm_(c)||z.some(function(x){return e.indexOf(x)>=0})))return[String(r[4]),String(r[5])]}return null}
function folder_(us,ids,co){for(var j=0;j<us.length;j++){var x=id_(us[j]);if(x)try{return DriveApp.getFolderById(x)}catch(e){}}var it=DriveApp.getFolderById(PS.root).getFolders(),cs=ids.concat([co]);while(it.hasNext()){var f=it.next(),n=norm_(f.getName());if(cs.some(function(x){return n.indexOf(norm_(x))>=0}))return f}throw Error('회사 폴드를 찾지 못했습니다. 원장의 구글 드라이브 열에 회사 폴더 URL을 넣어주세요.')}
function sub_(p,n){var i=p.getFoldersByName(n);return i.hasNext()?i.next():p.createFolder(n)} function id_(v){var m=String(v||'').match(/[A-Za-z0-9_-]{20,}/);return m?m[0]:''} function norm_(v){return String(v||'').toLowerCase().replace(/\s+/g,'').replace(/[^0-9a-z가-힣]/g,'')} function uniq_(a){return Array.from(new Set(a.map(function(x){return String(x).trim()}).filter(Boolean)))} function safe_(v){return String(v).replace(/[\\/:*?"<>|]/g,'_').slice(0,70)}
function links_(t,s,i){var h='<div style="font:14px Arial;padding:18px;line-height:1.8"><p>메일에는 상품 제출 시트 URL을 직접 붙여 넣으세요.</p><p><a target="_blank" href="'+s+'">상품 제출 시트 열기</a></p><p><a target="_blank" href="'+i+'">이미지 폴더 열기</a></p><input style="width:100%" value="'+s+'" onclick="this.select()"></div>';SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(h).setWidth(520).setHeight(280),t)}
var IMG_COL = 3; // C열
var PAD = 6;

// [시트행, 이미지URL]
var DATA = [
  [6, 'https://gi.esmplus.com/jooangle22/%EA%B4%91%EB%8F%99/%EA%B3%B5%EB%A0%A5%ED%99%98%20%EC%84%AC%EB%84%A4%EC%9D%BC.jpg']
];

function insertImages() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  var cw = sh.getColumnWidth(IMG_COL);
  var existing = sh.getImages();
  var ok = 0, fail = [];
  for (var i = 0; i < DATA.length; i++) {
    var row = DATA[i][0], url = DATA[i][1];
    try {
      // 같은 셀에 이미 꽂혀 있는 이미지 제거
      for (var k = 0; k < existing.length; k++) {
        var a = existing[k].getAnchorCell();
        if (a.getRow() === row && a.getColumn() === IMG_COL) { existing[k].remove(); }
      }
      sh.getRange(row, IMG_COL).clearContent(); // 기존 =IMAGE 수식 제거
      var blob = UrlFetchApp.fetch(url, {muteHttpExceptions: true, followRedirects: true}).getBlob();
      var img = sh.insertImage(blob, IMG_COL, row);
      var rh = sh.getRowHeight(row);
      var w = img.getWidth(), h = img.getHeight();
      var s = Math.min((cw - PAD) / w, (rh - PAD) / h);
      var nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
      img.setWidth(nw); img.setHeight(nh);
      img.setAnchorCellXOffset(Math.round((cw - nw) / 2));
      img.setAnchorCellYOffset(Math.round((rh - nh) / 2));
      ok++;
    } catch (e) {
      fail.push(row + ': ' + e);
    }
    SpreadsheetApp.flush();
  }
  Logger.log('성공 ' + ok + ' / 실패 ' + fail.length);
  if (fail.length) Logger.log(fail.join('\n'));
}