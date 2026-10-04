/** Google Drive: 브랜드 자료 루트 폴더와 하위 폴더. */

function driveRoot_() {
  const id = prop_(BO.PROPS.ROOT_FOLDER_ID);
  if (!id) throw userError_('브랜드 자료 루트 폴더가 설정되지 않았습니다. 스크립트 속성 BO_ROOT_FOLDER_ID를 확인해 주세요.');
  return DriveApp.getFolderById(id);
}

function childFolder_(parent, name) {
  const matches = parent.getFoldersByName(name);
  return matches.hasNext() ? matches.next() : parent.createFolder(name);
}
