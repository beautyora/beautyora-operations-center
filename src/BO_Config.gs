const BOPS = Object.freeze({
  VERSION: '0.1.0',
  SHEETS: {
    BRANDS: '브랜드 전체 목록(Notion 자동연동·수정금지)',
    INTAKE: '신규 브랜드 접수·검토',
    SUBMISSIONS: '상품 접수',
    PRODUCTS: '상품 마스터',
    FILES: '파일 목록',
    FIELDS: '필드 설정',
    LINKS: '파트너 링크',
    ALERTS: '알림·오류',
    LOGS: '처리 이력',
    FORM_MAP: '폼 연결 설정'
  },
  STATUS: {
    DRAFT: '작성 중',
    SUBMITTED: '신규 제출',
    REVIEWING: '검수 중',
    REVISION: '보완 필요',
    APPROVED: '승인 완료',
    REJECTED: '반려'
  },
  PROPS: {
    SPREADSHEET_ID: 'BO_SPREADSHEET_ID',
    ROOT_FOLDER_ID: 'BO_ROOT_FOLDER_ID',
    GOOGLE_FORM_ID: 'BO_GOOGLE_FORM_ID',
    NOTION_TOKEN: 'BO_NOTION_TOKEN',
    NOTION_DATABASE_ID: 'BO_NOTION_DATABASE_ID',
    ADMIN_EMAILS: 'BO_ADMIN_EMAILS',
    PARTNER_WEBAPP_URL: 'BO_PARTNER_WEBAPP_URL'
  },
  MAX_UPLOAD_BYTES: 8 * 1024 * 1024
});

const HEADERS = Object.freeze({
  '상품 접수': ['제출ID','브랜드코드','상품ID','제출버전','상태','제출일','수정일','상품데이터JSON','검수메모','제출자명','제출자연락처'],
  '상품 마스터': ['상품ID','브랜드코드','브랜드명','상품명','옵션명','바코드','소비자가','매입가','카테고리','상태','대표이미지URL','상세페이지URL','승인일','상품데이터JSON'],
  '파일 목록': ['파일ID','브랜드코드','상품ID','분류','파일명','Drive파일ID','DriveURL','업로드일','상태'],
  '필드 설정': ['내부ID','표시이름','입력형식','필수','사용','순서','선택지','도움말','엑셀포함'],
  '파트너 링크': ['토큰','브랜드코드','상태','만료일','마지막접속','발급일','발급자'],
  '알림·오류': ['알림ID','등급','구분','제목','상세','대상ID','상태','발생일','해결일'],
  '처리 이력': ['이력ID','일시','사용자','작업','대상구분','대상ID','상세'],
  '폼 연결 설정': ['내부ID','구글폼질문ID','현재질문명','필수','상태','마지막확인','선택지JSON']
});

const DEFAULT_FIELDS = Object.freeze([
  ['product_name','상품명','text',true,true,1,'','정확한 상품명을 입력해 주세요.',true],
  ['option_name','옵션명','text',false,true,2,'','옵션이 없으면 비워 주세요.',true],
  ['category','카테고리','select',true,true,3,'스킨케어|메이크업|헤어|바디|구강|기타','가장 가까운 분류를 선택해 주세요.',true],
  ['barcode','바코드','text',true,true,4,'','숫자 앞의 0이 사라지지 않게 입력해 주세요.',true],
  ['retail_price','소비자가','number',true,true,5,'','원 단위 숫자로 입력해 주세요.',true],
  ['purchase_price','매입가','number',false,true,6,'','부가세 포함 여부를 메모에 남겨 주세요.',true],
  ['description','제품 설명','textarea',false,true,7,'','핵심 특징을 간단히 입력해 주세요.',true],
  ['reference_url','참고 링크','url',false,true,8,'','공식 판매 페이지가 있다면 입력해 주세요.',true]
]);
