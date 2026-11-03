/**
 * Request-only compatibility for official NapCat v4.18.42.
 * No IO, credential access, media guessing, or Qzone response rewriting.
 * The caller supplies the logged-in nickname when changing only a signature.
 * Explicit mediaType (or params.media_type) selects album video upload.
 */
export function adaptOneBotRequest(action, params = {}, { gateway = 'snowluma', selfNickname = '', mediaType } = {}) {
  if (String(gateway).toLowerCase() !== 'napcat') return { action, params };
  let nextAction = action;
  const next = { ...params };

  if (action === 'set_qq_profile') {
    if (next.signature !== undefined) {
      if (next.personal_note !== undefined && next.personal_note !== next.signature) {
        throw new Error('NapCat profile: signature 与 personal_note 冲突');
      }
      next.personal_note = next.signature;
      delete next.signature;
    }
    if (next.sex !== undefined) {
      const sex = { unknown: 0, male: 1, female: 2 }[String(next.sex).toLowerCase()];
      const numeric = sex ?? Number(next.sex);
      if (!['0', '1', '2'].includes(String(next.sex)) && sex === undefined) {
        throw new Error('NapCat profile: sex 必须为 unknown/male/female 或 0/1/2');
      }
      next.sex = numeric;
    }
    if (!next.nickname) {
      if (!selfNickname) throw new Error('NapCat profile: 仅修改签名/性别需要已登录账号的 nickname');
      next.nickname = selfNickname;
    }
  }

  if (action === 'get_group_album_list') nextAction = 'get_qun_album_list';

  if (action === 'upload_image_to_qun_album' || action === 'upload_video_to_qun_album') {
    const kind = mediaType ?? next.media_type;
    if (kind !== undefined && kind !== 'image' && kind !== 'video') {
      throw new Error('NapCat album: media_type 必须明确为 image 或 video');
    }
    if (mediaType !== undefined && next.media_type !== undefined && mediaType !== next.media_type) {
      throw new Error('NapCat album: mediaType 与 media_type 冲突');
    }
    if (action === 'upload_video_to_qun_album' && kind === 'image') {
      throw new Error('NapCat album: 视频上传动作不能指定 image');
    }
    if (kind === 'video') nextAction = 'upload_video_to_qun_album';
    delete next.media_type;
    if (next.text !== undefined && next.text !== '') {
      throw new Error('NapCat album: 上传接口不支持 text 配文，请单独发送说明或使用相册评论接口');
    }
    delete next.text;
    next.album_name ??= '';
  }
  return { action: nextAction, params: next };
}
