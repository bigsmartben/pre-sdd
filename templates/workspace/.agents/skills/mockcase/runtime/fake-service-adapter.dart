import '../../../implement-flutter-ui/templates/flutter-workspace/lib/adapters/contracts/service_port.dart';

/// Review/Test-only adapter template. Never include it in the accepted source closure.
final class MockCaseServiceAdapter implements ServicePort {
  MockCaseServiceAdapter(this.fixtures);

  final Map<String, Object?> fixtures;

  @override
  Future<void> execute() async {}
}
