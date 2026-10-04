/**
 * 뷰티오라 입점 제안서 ↔ 구글 폼 연결 스크립트
 *
 * 구글 폼 편집 화면 ⋮ → Apps Script 에 이 파일 내용을 그대로 붙여넣고
 * "웹 앱"으로 배포합니다. (README의 "구글 폼 연결 스크립트" 참고)
 *
 *  - GET  : 구글 폼의 질문 목록(제목·설명·보기·필수 여부·섹션)을 JSON으로 돌려줍니다.
 *           beautyora.kr/apply/ 페이지가 이 목록으로 화면을 그립니다.
 *  - POST : 페이지에서 받은 답을 구글 폼 응답으로 저장합니다.
 *           저장에 실패하면 이유를 돌려주어, 페이지가 "전송되지 않았습니다"를 보여줍니다.
 *
 * 이 스크립트는 폼 구조를 읽고 응답을 추가하는 일만 합니다.
 * 기존 응답을 읽거나 폼을 고치지 않습니다.
 */

var CACHE_SECONDS = 60;   // 폼을 고친 뒤 페이지에 반영되기까지 최대 1분
var CACHE_KEY = 'beautyora-form-v1';

/* ── 질문 목록 ─────────────────────────────────────────────── */
function doGet() {
  var cache = CacheService.getScriptCache();
  var body = cache.get(CACHE_KEY);
  if (!body) {
    body = JSON.stringify(describeForm_());
    try { cache.put(CACHE_KEY, body, CACHE_SECONDS); } catch (e) { /* 너무 크면 캐시 없이 */ }
  }
  return out_(body);
}

function describeForm_() {
  var form = FormApp.getActiveForm();
  var T = FormApp.ItemType;
  var sections = [{ title: '', help: '', items: [] }];

  form.getItems().forEach(function (item) {
    var type = item.getType();
    var q = { id: String(item.getId()), title: item.getTitle(), help: item.getHelpText() || '' };
    var typed;

    switch (type) {
      case T.PAGE_BREAK:
        sections.push({ title: q.title, help: q.help, items: [] });
        return;
      case T.SECTION_HEADER:
        q.type = 'header';
        break;
      case T.TEXT:
        typed = item.asTextItem(); q.type = 'text'; break;
      case T.PARAGRAPH_TEXT:
        typed = item.asParagraphTextItem(); q.type = 'paragraph'; break;
      case T.MULTIPLE_CHOICE:
        typed = item.asMultipleChoiceItem(); q.type = 'radio';
        q.choices = typed.getChoices().map(function (c) { return c.getValue(); });
        q.other = typed.hasOtherOption();
        break;
      case T.CHECKBOX:
        typed = item.asCheckboxItem(); q.type = 'checkbox';
        q.choices = typed.getChoices().map(function (c) { return c.getValue(); });
        q.other = typed.hasOtherOption();
        break;
      case T.LIST:
        typed = item.asListItem(); q.type = 'select';
        q.choices = typed.getChoices().map(function (c) { return c.getValue(); });
        break;
      case T.DATE:
        typed = item.asDateItem(); q.type = 'date'; break;
      case T.SCALE:
        typed = item.asScaleItem(); q.type = 'scale';
        q.min = typed.getLowerBound(); q.max = typed.getUpperBound();
        q.minLabel = typed.getLeftLabel() || ''; q.maxLabel = typed.getRightLabel() || '';
        break;
      case T.IMAGE:
      case T.VIDEO:
        return;   // 보여줄 글이 없는 항목은 건너뜁니다
      default:
        q.type = 'unsupported';   // 파일 업로드 · 표형 질문 · 시간 등
        q.kind = String(type);
    }
    if (typed) q.required = typed.isRequired();
    sections[sections.length - 1].items.push(q);
  });

  return {
    ok: true,
    title: form.getTitle(),
    description: form.getDescription() || '',
    accepting: form.isAcceptingResponses(),
    closedMessage: form.getCustomClosedFormMessage() || '',
    url: form.getPublishedUrl(),
    sections: sections.filter(function (s) { return s.items.length; })
  };
}

/* ── 응답 저장 ─────────────────────────────────────────────── */
function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (req.hp) return out_({ ok: true });   // 자동 입력 봇이 채우는 숨은 칸

    var form = FormApp.getActiveForm();
    if (!form.isAcceptingResponses()) return out_({ ok: false, error: 'closed' });

    var T = FormApp.ItemType;
    var answers = req.answers || {};
    var response = form.createResponse();
    var missing = [], bad = [];

    form.getItems().forEach(function (item) {
      var type = item.getType(), typed;
      switch (type) {
        case T.TEXT: typed = item.asTextItem(); break;
        case T.PARAGRAPH_TEXT: typed = item.asParagraphTextItem(); break;
        case T.MULTIPLE_CHOICE: typed = item.asMultipleChoiceItem(); break;
        case T.CHECKBOX: typed = item.asCheckboxItem(); break;
        case T.LIST: typed = item.asListItem(); break;
        case T.DATE: typed = item.asDateItem(); break;
        case T.SCALE: typed = item.asScaleItem(); break;
        default: return;
      }

      var v = answers[String(item.getId())];
      var empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
      if (empty) {
        if (typed.isRequired()) missing.push(item.getTitle());
        return;
      }

      try {
        // 보기에 없는 값은 받지 않습니다 ("기타"가 켜진 질문은 예외)
        if (type === T.MULTIPLE_CHOICE || type === T.CHECKBOX || type === T.LIST) {
          var allowed = typed.getChoices().map(function (c) { return c.getValue(); });
          var other = type !== T.LIST && typed.hasOtherOption();
          var vals = [].concat(v).map(String);
          var stray = vals.filter(function (x) { return allowed.indexOf(x) < 0; });
          if (stray.length && (!other || stray.length > 1)) throw new Error('choice');
          v = type === T.CHECKBOX ? vals : vals[0];
        }

        var r;
        if (type === T.DATE) {
          var p = String(v).split('-');
          r = typed.createResponse(new Date(+p[0], +p[1] - 1, +p[2]));
        } else if (type === T.SCALE) {
          r = typed.createResponse(Number(v));
        } else if (type === T.CHECKBOX) {
          r = typed.createResponse(v);
        } else {
          r = typed.createResponse(String(v));
        }
        response.withItemResponse(r);
      } catch (err) {
        bad.push(item.getTitle());
      }
    });

    if (missing.length || bad.length) {
      return out_({ ok: false, error: 'invalid', missing: missing, bad: bad });
    }
    response.submit();
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: 'server', message: String(err) });
  }
}

function out_(body) {
  return ContentService
    .createTextOutput(typeof body === 'string' ? body : JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
