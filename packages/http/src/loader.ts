import { ControllerRegisterProps } from './controller';
import { Http } from './http';
import { glob } from 'glob';
import { resolve } from 'node:path';

export interface LoaderCompileOptions {
  defaultSuffix?: string; // 默认后缀，解析后将被重置为/或空字符串
  prefix?: string; // 前缀
}

export type LoaderFromOptions = {
  suffix?: string; // 标记以什么后缀结尾的文件为路由
} & LoaderCompileOptions;

export class Loader {
  constructor(private readonly http: Http) { }

  /**
   * 单个路由绑定编译
   * @param path 路径
   * @param controllers 控制器数组或单个控制器
   * @param options 选项
   * @returns 注销回调
   */
  public compile<R>(path: string, controllers: ControllerRegisterProps<R> | ControllerRegisterProps<R>[], options: LoaderCompileOptions = {
    defaultSuffix: '/index',
  }) {
    const callbacks: (() => void)[] = [];

    // 格式化路径，去除默认后缀
    const defaultSuffix = options.defaultSuffix || '/index';
    let url = path.startsWith('/') ? path : '/' + path;
    if (url.endsWith(defaultSuffix)) {
      url = url.substring(0, url.length - defaultSuffix.length);
    }
    if (!url) url = '/';

    // 如果导出单个路由，则转化为数组，批量执行
    if (!Array.isArray(controllers)) {
      controllers = [controllers];
    }

    // 添加前缀
    const _url = options.prefix ? options.prefix + url : url;

    // 将路径中的参数转换为路由参数
    const router_url = _url.replace(/\[([^\]]+)\]/g, ':$1');

    // 批量注册路由
    for (let i = 0; i < controllers.length; i++) {
      const controller = controllers[i];
      const { method, middlewares } = controller;
      controller.data.url = router_url;
      callbacks.push(
        this.http.route(method, router_url, ...middlewares)
      );
    }

    // 销毁路由绑定的回调
    return () => {
      let j = callbacks.length;
      while (j--) callbacks[j]();
    };
  }

  /**
   * 文件夹批量路由绑定编译
   * @param directory 文件夹路径
   * @param options 选项
   * @returns 注销回调
   */
  public async from(directory: string, options: LoaderFromOptions = {
    defaultSuffix: '/index',
    suffix: 'controller',
  }) {
    const { suffix = 'controller', ...extras } = options;

    // 获取文件夹下的所有文件
    const files = await glob(`**/*.${suffix}.{ts,js}`, { cwd: directory });

    // 批量注册路由
    const callbacks = await Promise.all(files.map(async (file) => {
      // 获取文件绝对路径
      const path = resolve(directory, file);
      // 获取文件地址
      const url = file.substring(0, file.length - suffix.length - 4);
      // 导入文件
      const controller = await import(path);
      // 获取文件导出的默认函数
      const { default: fn } = controller;
      // 注册路由
      return this.compile(url, fn, extras);
    }));

    // 销毁路由绑定的回调
    return () => {
      let i = callbacks.length;
      while (i--) callbacks[i]();
    }
  }
}