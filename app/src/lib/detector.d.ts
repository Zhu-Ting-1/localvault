// detector.js 的最小类型声明（UMD 形式，便于 jsdom 里直接复测）
export interface DetectedField {
  selector: string;
  name: string;
  id: string;
  type: string;
  autocomplete: string;
  placeholder: string;
  label: string;
  visible: boolean;
  honeypot: boolean;
  disabled: boolean;
  readOnly: boolean;
  fillable: boolean;
  /** 非枚举属性：真实 DOM 元素引用（内容脚本内可用） */
  _el?: HTMLInputElement;
}

export interface DetectedForm {
  type: 'login' | 'signup' | 'change' | 'otp' | 'username-only';
  confidence: number;
  container: string;
  username: DetectedField | null;
  password: DetectedField | null;
  passwords: DetectedField[];
  /** 验证码登录（type='otp'）时的验证码输入框 */
  otp?: DetectedField | null;
  reasons: string[];
}

export interface DetectResult {
  url: string;
  title: string;
  forms: DetectedForm[];
  stats: {
    passwordInputs: number;
    visiblePasswords: number;
    hiddenPasswords: number;
    honeypots: number;
    shadowRoots: number;
  };
  detectedAt: string;
}

export declare function detectDocument(doc: Document, win?: Window): DetectResult;