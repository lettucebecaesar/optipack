/**
 * Functional mock of @minecraft/server-ui for the differential harness.
 *
 * Models the widely used form surface accurately: ActionFormData,
 * MessageFormData, ModalFormData (chainable builders), uiManager.showPlayer,
 * and the response types. `.show()`/`showPlayer()` record a harness effect
 * carrying the form's kind and title, then resolve with a scripted response
 * from the recorder (key: `uiResponse:<entityId>`, default: a non-canceled
 * selection). Names present in the real 2.2.0 module but not modeled in depth
 * (CustomForm, MessageBox, observables, error classes) are bound to permissive
 * stubs so any fixture using them still links and runs.
 */
import { permissive } from '../permissive.mjs';

const rec = () => globalThis.__opkRecorder;

function scriptedResponse(player) {
  const r = rec();
  const key = 'uiResponse:' + (player && player.id !== undefined ? player.id : 'unknown');
  const base = r ? r.scriptedRead(key, undefined) : undefined;
  if (base) return base;
  return { selection: 0, formValues: [0], canceled: false, cancelationReason: undefined };
}

class FormBase {
  constructor(kind) {
    this.__kind = kind;
    this.__data = { title: undefined, body: undefined, buttons: [], fields: [] };
  }
  __chain(mutator) {
    mutator();
    return this;
  }
  title(text) { return this.__chain(() => { this.__data.title = String(text); }); }
  body(text) { return this.__chain(() => { this.__data.body = String(text); }); }
  __show(player) {
    const r = rec();
    if (r) r.effect('ui.show', { kind: this.__kind, title: this.__data.title, player: player && player.id !== undefined ? player.id : null });
    const response = scriptedResponse(player);
    return Promise.resolve(response);
  }
}

export class ActionFormData extends FormBase {
  constructor() { super('ActionFormData'); }
  button(text, iconPath) { return this.__chain(() => { this.__data.buttons.push({ text: String(text), iconPath }); }); }
  divider() { return this.__chain(() => { this.__data.buttons.push({ divider: true }); }); }
  header(text) { return this.__chain(() => { this.__data.header = String(text); }); }
  label(text) { return this.__chain(() => { this.__data.fields.push({ type: 'label', text: String(text) }); }); }
  show(player) { return this.__show(player); }
}

export class MessageFormData extends FormBase {
  constructor() { super('MessageFormData'); }
  button1(text) { return this.__chain(() => { this.__data.buttons[0] = { text: String(text) }; }); }
  button2(text) { return this.__chain(() => { this.__data.buttons[1] = { text: String(text) }; }); }
  show(player) { return this.__show(player); }
}

export class ModalFormData extends FormBase {
  constructor() { super('ModalFormData'); }
  textField(label, placeholder, options) { return this.__chain(() => { this.__data.fields.push({ type: 'textField', label: String(label), placeholder, options }); }); }
  slider(label, min, max, step, deflt) { return this.__chain(() => { this.__data.fields.push({ type: 'slider', label: String(label), min, max, step, default: deflt }); }); }
  toggle(label, deflt) { return this.__chain(() => { this.__data.fields.push({ type: 'toggle', label: String(label), default: deflt }); }); }
  dropdown(label, options, deflt) { return this.__chain(() => { this.__data.fields.push({ type: 'dropdown', label: String(label), options, default: deflt }); }); }
  divider() { return this.__chain(() => { this.__data.fields.push({ type: 'divider' }); }); }
  header(text) { return this.__chain(() => { this.__data.header = String(text); }); }
  label(text) { return this.__chain(() => { this.__data.fields.push({ type: 'label', text: String(text) }); }); }
  submitButton(text) { return this.__chain(() => { this.__data.submitButtonText = String(text); }); }
  show(player) { return this.__show(player); }
}

class UIManagerImpl {
  showPlayer(player, form) {
    const r = rec();
    if (r) r.effect('ui.showPlayer', { kind: form && form.__kind, title: form && form.__data && form.__data.title, player: player && player.id !== undefined ? player.id : null });
    const response = scriptedResponse(player);
    return Promise.resolve(response);
  }
  close(player) {
    const r = rec();
    if (r) r.effect('ui.close', { player: player && player.id !== undefined ? player.id : null });
  }
}

export const uiManager = new UIManagerImpl();

// Response constructors: usable with `new`, mirror the scripted/plain shape.
export class FormResponse {
  constructor(init = {}) { Object.assign(this, { canceled: false, cancelationReason: undefined }, init); }
}
export class ActionFormResponse extends FormResponse {
  constructor(init = {}) { super({ selection: 0, ...init }); }
}
export class MessageFormResponse extends FormResponse {
  constructor(init = {}) { super({ selection: 0, ...init }); }
}
export class ModalFormResponse extends FormResponse {
  constructor(init = {}) { super({ formValues: [], ...init }); }
}

export const FormCancelationReason = Object.freeze({
  UserBusy: 'UserBusy',
  UserClosed: 'UserClosed',
  ServerCrashed: 'ServerCrashed',
});

// Present in the real module but not modeled in depth: permissive stubs so
// named imports link and recorded effects stay identical on both sides.
export const CustomForm = permissive('server-ui.CustomForm');
export const MessageBox = permissive('server-ui.MessageBox');
export const ObservableBoolean = permissive('server-ui.ObservableBoolean');
export const ObservableNumber = permissive('server-ui.ObservableNumber');
export const ObservableString = permissive('server-ui.ObservableString');
export const ObservableUIRawMessage = permissive('server-ui.ObservableUIRawMessage');
export const DataDrivenScreenClosedReason = permissive('server-ui.DataDrivenScreenClosedReason');
export const FormRejectError = permissive('server-ui.FormRejectError');
export const FormRejectReason = permissive('server-ui.FormRejectReason');
export const FormVisibilityError = permissive('server-ui.FormVisibilityError');
export const FormVisibilityErrorReason = permissive('server-ui.FormVisibilityErrorReason');
export const InvalidFormError = permissive('server-ui.InvalidFormError');
export const InvalidFormModificationError = permissive('server-ui.InvalidFormModificationError');
export const InvalidObservableError = permissive('server-ui.InvalidObservableError');
export const PlayerLeftError = permissive('server-ui.PlayerLeftError');
export const TextFilteringError = permissive('server-ui.TextFilteringError');
