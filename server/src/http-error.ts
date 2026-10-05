/** 统一业务错误，携带 HTTP 状态码与可展示给用户的原因。 */
export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
