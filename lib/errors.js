export function unsupported(method) {
    throw new UnsupportedMethod(method);
}
export function unimplemented(method) {
    throw new UnimplementedMethod(method);
}
export function expectArgs(args, min, max, minMsg) {
    if (args && args.length < min)
        throw new MissingArgument(min - 1, minMsg);
    if (args && args.length > max)
        throw new TooManyArguments(max);
    //if (args.length > max) throw new InvalidArguments();
}
export class CodedError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        Object.setPrototypeOf(this, CodedError.prototype);
    }
}
export class UnsupportedMethod extends CodedError {
    constructor(method) {
        super(-32601, `Unsupported method: ${method}`);
        Object.setPrototypeOf(this, UnsupportedMethod.prototype);
    }
}
export class UnimplementedMethod extends CodedError {
    constructor(method) {
        super(-32601, `Unimplemented method: ${method}`);
        Object.setPrototypeOf(this, UnimplementedMethod.prototype);
    }
}
export class MissingArgument extends CodedError {
    constructor(index, message) {
        super(-32602, message || `missing value for required argument ${index}`);
        Object.setPrototypeOf(this, MissingArgument.prototype);
    }
}
export class TooManyArguments extends CodedError {
    constructor(maxCount) {
        super(-32602, `too many arguments, want at most ${maxCount}`);
        Object.setPrototypeOf(this, TooManyArguments.prototype);
    }
}
export class InvalidArguments extends CodedError {
    constructor() {
        super(-32602, `Invalid method parameter(s).`);
        Object.setPrototypeOf(this, InvalidArguments.prototype);
    }
}