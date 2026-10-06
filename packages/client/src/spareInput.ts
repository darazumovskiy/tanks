// Запас команд на сервере, который не понадобился: снимок с флагом просит пропустить один шаг ввода — команда
// не уходит, предсказание не шагает, запас на сервере уходит без потери команд. Флаг в снимках идёт ещё круг связи
// после пропуска, поэтому следующий пропуск — только когда сервер подтвердил команду, отправленную после прошлого.
export class SpareInput {
  private isSkipDue = false;
  private resumeSeq = 0;

  noteSnapshot(ackSeq: number, hasSpareInput: boolean): void {
    if (hasSpareInput && ackSeq >= this.resumeSeq) {
      this.isSkipDue = true;
    }
  }

  // nextSeq — номер, который получит следующая отправленная команда.
  shouldSkip(nextSeq: number): boolean {
    if (!this.isSkipDue) {
      return false;
    }
    this.isSkipDue = false;
    this.resumeSeq = nextSeq;
    return true;
  }

  // Новое соединение: номера команд снова с единицы.
  reset(): void {
    this.isSkipDue = false;
    this.resumeSeq = 0;
  }
}
