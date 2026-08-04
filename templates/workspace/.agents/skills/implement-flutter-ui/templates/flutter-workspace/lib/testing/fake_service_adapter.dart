import '../adapters/contracts/service_port.dart';

final class FakeServiceAdapter implements ServicePort {
  @override
  Future<void> execute() async {}
}
